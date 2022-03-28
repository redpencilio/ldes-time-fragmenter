import { app, uuid, errorHandler } from "mu";
import bodyParser from "body-parser";
import rdfParser from "rdf-parse";
import rdfSerializer from "rdf-serialize";
import fs from "fs";
import jsstream from "stream";
import { storeStream } from "rdf-store-stream";
import { Store, DataFactory, Quad } from "n3";
const { namedNode, quad, literal } = DataFactory;

app.use(
  bodyParser.text({
    type: function (req: any) {
      return true;
    },
  })
);

import {
  readTriplesStream,
  lastPage,
  clearLastPageCache,
  writeTriplesStream,
} from "./storage/files";

const FEED_FILE = "/app/data/feed.ttl";
const PAGES_FOLDER = "/app/data/pages/";
const GRAPH = namedNode("http://mu.semte.ch/services/ldes-time-fragmenter");
const MAX_RESOURCES_PER_PAGE = 10;
const SERVICE_PATH = "http://localhost:8888/"; // a workaround for json-ld not accepting relative paths

const stream = namedNode(
  "http://mu.semte.ch/services/ldes-time-fragmenter/example-stream"
);

function generateVersion(_namedNode: any) {
  return namedNode(
    `http://mu.semte.ch/services/ldes-time-fragmenter/versioned/${uuid()}`
  );
}

function generateTreeRelation() {
  return namedNode(
    `http://mu.semte.ch/services/ldes-time-fragmenter/relations/${uuid()}`
  );
}

function generatePageResource(number: number) {
  return namedNode(`${SERVICE_PATH}pages?page=${number}`);
}

function nowLiteral() {
  const xsdDateTime = namedNode("http://www.w3.org/2001/XMLSchema#dateTime");
  const now = new Date().toISOString();
  return literal(now, xsdDateTime);
}

/**
 * Yields the file path on which the specified page number is described.
 *
 * @param {number} page Page index for which we want te get the file path.
 * @return {string} Path to the page.
 */
function fileForPage(page: number) {
  return `${PAGES_FOLDER}${page}.ttl`;
}

/**
 * Yield the amount of solutions in the specified graph of the store.
 *
 * @param {Store} store Store containing all the triples.
 * @param {NamedNode} graph The graph containing the data.
 */
function countVersionedItems(store: Store): number {
  let count = store.countQuads(
    stream,
    namedNode("https://w3id.org/tree#member"),
    undefined,
    undefined
  );
  return count;
}

/**
 * Indicates whether or not we should create a new page.
 *
 * @param {Store} store Store which contains parsed triples.
 * @return {boolean} Truethy if we should create a new file.
 */
function shouldCreateNewPage(store: Store): boolean {
  return countVersionedItems(store) >= MAX_RESOURCES_PER_PAGE;
}

/**
 * Publishes a new version of the same resource.
 */
app.post("/resource", async function (req: any, res: any) {
  try {
    const contentType = req.headers["content-type"];

    const resource = namedNode(req.query.resource);
    const versionedResource = generateVersion(resource);

    const bodyStream = jsstream.Readable.from(req.body);

    const quadStream = rdfParser.parse(bodyStream, {
      contentType: contentType,
    });

    const store = new Store();

    store.import(quadStream);

    const versionedStore = new Store();

    for (let match of store.match()) {
      versionedStore.add(
        quad(
          match.subject.equals(resource) ? versionedResource : match.subject,
          match.predicate.equals(resource)
            ? versionedResource
            : match.predicate,
          match.object.equals(resource) ? versionedResource : match.object
        )
      );
    }

    const dateLiteral = nowLiteral();

    let a = versionedStore.getQuads(null, null, null, null);

    // add resources about this version
    versionedStore.add(
      quad(
        versionedResource,
        namedNode("http://purl.org/dc/terms/isVersionOf"),
        resource
      )
    );

    versionedStore.add(
      quad(
        versionedResource,
        namedNode("http://www.w3.org/ns/sosa/resultTime"),
        dateLiteral
      )
    );

    versionedStore.add(
      quad(stream, namedNode("https://w3id.org/tree#member"), versionedResource)
    );

    // read the current dataset
    const lastPageNr = lastPage(PAGES_FOLDER);
    let pageFile = fileForPage(lastPageNr);

    let currentDataset = new Store();

    currentDataset.import(readTriplesStream(pageFile));

    if (shouldCreateNewPage(currentDataset)) {
      const closingDataset = currentDataset;

      // link the current dataset to the new dataset but don't save yet
      const closingPageFile = pageFile;
      const nextPageFile = fileForPage(lastPageNr + 1);
      const relationResource = generateTreeRelation();
      const currentPageResource = generatePageResource(lastPageNr);
      const nextPageResource = generatePageResource(lastPageNr + 1);
      closingDataset.add(
        quad(
          currentPageResource,
          namedNode("https://w3id.org/tree#relation"),
          relationResource
        )
      );
      closingDataset.add(
        quad(
          relationResource,
          namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"),
          namedNode("https://w3id.org/tree#GreaterThanOrEqualRelation")
        )
      );
      closingDataset.add(
        quad(
          relationResource,
          namedNode("https://w3id.org/tree#node"),
          nextPageResource
        )
      );
      closingDataset.add(
        quad(
          relationResource,
          namedNode("https://w3id.org/tree#path"),
          namedNode("http://www.w3.org/ns/sosa/resultTime")
        )
      );
      closingDataset.add(
        quad(
          relationResource,
          namedNode("https://w3id.org/tree#value"),
          dateLiteral
        )
      );

      // create a store with the new graph for the new file
      currentDataset = new Store();
      currentDataset.import(readTriplesStream(FEED_FILE));
      currentDataset.add(
        quad(
          nextPageResource,
          namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"),
          namedNode("https://w3id.org/tree#Node")
        )
      );
      currentDataset.addQuads(versionedStore.getQuads(null, null, null, null));

      // // Write out new dataset to nextPageFile
      writeTriplesStream(currentDataset, nextPageFile);
      // // Write out closing dataset to closingPageFile
      writeTriplesStream(closingDataset, closingPageFile);
      // Clear the last page cache
      clearLastPageCache(PAGES_FOLDER);
    } else {
      currentDataset.addQuads(versionedStore.getQuads(null, null, null, null));
      writeTriplesStream(currentDataset, pageFile);
    }
    console.log(currentDataset);
    const newCount = countVersionedItems(currentDataset);

    res.status(200).send(`{"message": "ok", "triplesInPage": ${newCount}}`);
  } catch (e) {
    console.error(e);
    res.status(500).send();
  }
});

app.get("/", function (req: any, res: any) {
  // LDES does not use this index page
  try {
    const fileStream = fs.createReadStream(FEED_FILE);
    const rdfStream = rdfParser.parse(fileStream, {
      contentType: "text/turtle",
    });

    res.header("Content-Type", req.headers["accept"]);

    rdfSerializer
      .serialize(rdfStream, {
        contentType: req.headers["accept"],
      })
      .on("data", (d) => res.write(d))
      .on("error", (error) => {
        console.log(error);
      })
      .on("end", () => {
        res.end();
      });
  } catch (e) {
    console.error(e);
  }
});

app.get("/pages", function (req: any, res: any) {
  try {
    const page = parseInt(req.query.page);

    if (page < lastPage(PAGES_FOLDER))
      res.header("Cache-Control", "public, immutable");

    const fileStream = fs.createReadStream(fileForPage(page));
    const rdfStream = rdfParser.parse(fileStream, {
      contentType: "text/turtle",
    });

    res.header("Content-Type", req.headers["accept"]);

    rdfSerializer
      .serialize(rdfStream, {
        contentType: req.headers["accept"],
      })
      .on("data", (d) => res.write(d))
      .on("error", (error) => {
        throw error;
      })
      .on("end", () => {
        res.end();
      });
  } catch (e) {
    console.error(e);
    res.status(500).send();
  }
});

app.get("/count", async function (_req: any, res: any) {
  try {
    const file = fileForPage(lastPage(PAGES_FOLDER));
    console.log(`Reading from ${file}`);

    const currentDataset = new Store();
    currentDataset.import(readTriplesStream(file));
    const count = countVersionedItems(currentDataset);
    res.status(200).send(`{"count": ${count}}`);
  } catch (e) {
    console.error(e);
    res.status(500).send();
  }
});

app.get("/last-page", function (_req: any, res: any) {
  try {
    const page = lastPage(PAGES_FOLDER);
    if (page === NaN) res.status(500).send(`{"message": "No pages found"}`);
    else res.status(200).send(`{"lastPage": ${page}}`);
  } catch (e) {
    console.error(e);
    res.status(500).send();
  }
});

app.use(errorHandler);