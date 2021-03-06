import { app, uuid, errorHandler } from "mu-javascript-library";
import bodyParser from "body-parser";
import rdfParser from "rdf-parse";
import rdfSerializer from "rdf-serialize";
import jsstream from "stream";
import { DataFactory } from "n3";
import cors from "cors";
import path from "path";
const { namedNode } = DataFactory;
app.use(cors());
app.use(
	bodyParser.text({
		type: function (req: any) {
			return true;
		},
	})
);

import { convert, convertToJsonLD, readTriplesStream } from "./storage/files";
import PromiseQueue from "./promise-queue";
import TimeFragmenter from "./fragmenters/TimeFragmenter";
import { BASE_FOLDER, error, Newable } from "./utils/utils";
import Resource from "./models/resource";
import Node from "./models/node";
import PrefixTreeFragmenter from "./fragmenters/PrefixTreeFragmenter";
import Cache from "./storage/cache";
import Fragmenter from "./fragmenters/Fragmenter";

const UPDATE_QUEUE = new PromiseQueue<Node | null | void>();

const cache: Cache = new Cache();

const FRAGMENTERS = new Map<string, Newable<Fragmenter>>();

FRAGMENTERS.set("time-fragmenter", TimeFragmenter);

FRAGMENTERS.set("prefix-tree-fragmenter", PrefixTreeFragmenter);

/**
 * Yields the file path on which the specified page number is described.
 *
 * @param {number} page Page index for which we want te get the file path.
 * @return {string} Path to the page.
 */
function fileForPage(folder: string, page: number) {
	return `${folder}/${page}.ttl`;
}

app.post("/:folder", async function (req: any, res: any, next: any) {
	try {
		if (
			!(
				req.query.resource &&
				req.query.stream &&
				req.query["relation-path"]
			)
		) {
			throw new Error(
				"Resource, stream or relationPath parameters where not supplied"
			);
		}
		if (req.query.fragmenter && !FRAGMENTERS.has(req.query.fragmenter)) {
			throw new Error("Supplied fragmenter type does not exist");
		}

		const fragmenterClass =
			FRAGMENTERS.get(req.query.fragmenter) || TimeFragmenter;
		const fragmenter = new fragmenterClass(
			path.join(BASE_FOLDER, req.params.folder),
			namedNode(req.query.stream),
			100,
			namedNode(req.query["relation-path"]),
			100,
			5,
			cache
		);
		const contentTypes = await rdfParser.getContentTypes();
		if (!contentTypes.includes(req.headers["content-type"])) {
			return next(error(400, "Content-Type not recognized"));
		}

		const quadStream = rdfParser.parse(jsstream.Readable.from(req.body), {
			contentType: req.headers["content-type"],
		});
		const resource = new Resource(namedNode(req.query.resource));
		for await (const quadObj of quadStream) {
			resource.addProperty(quadObj.predicate.value, quadObj.object);
		}

		console.log(resource);

		const currentDataset = await UPDATE_QUEUE.push(() =>
			fragmenter.addResource(resource)
		);

		await UPDATE_QUEUE.push(() => cache.flush());

		if (currentDataset) {
			console.log(currentDataset.id);
			res.status(201).send(
				`{"message": "ok", "triplesInPage": ${currentDataset.count()}}`
			);
		}
	} catch (e) {
		console.error(e);
		return next(error(500, e));
	}
});

app.get("/:folder*/:nodeId", async function (req: any, res: any, next: any) {
	try {
		const page = parseInt(req.params.nodeId);
		const pagesFolder = path.join(BASE_FOLDER, req.params.folder);

		if (page > cache.getLastPage(pagesFolder)) {
			return next(error(404, "Page not found"));
		}

		if (page < cache.getLastPage(pagesFolder))
			res.header("Cache-Control", "public, immutable");

		const contentTypes = await rdfSerializer.getContentTypes();

		const contentType = req.accepts(contentTypes);
		if (!contentType) {
			return next(error(406));
		}
		const filePath = fileForPage(
			path.join(pagesFolder, req.params[0] || ""),
			page
		);
		res.header("Content-Type", contentType);
		const serializedStream = convert(filePath, contentType);
		serializedStream
			.on("data", (d) => res.write(d))
			.on("error", (error) => {
				next(error(500, error));
			})
			.on("end", () => {
				res.end();
			});
	} catch (e) {
		console.error(e);
		return next(error(500, e));
	}
});

app.use(errorHandler);
