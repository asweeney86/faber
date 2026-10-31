import { useState } from "react";
import type { AddDocResponse } from "@faber/shared";
import { docTitle, type Route } from "../lib";
import { AddDocForm, NEEDS_CONTENT } from "../components/AddDoc";
import { PageHeader, useDrawer } from "../components/ui";

/** #/add?url=…&title=… — the bookmarklet lands here with the form prefilled. */
export function AddPage({ route }: { route: Route }) {
  const drawer = useDrawer();
  const [result, setResult] = useState<AddDocResponse | null>(null);
  const [formKey, setFormKey] = useState(0);
  const prefill = { url: route.query.get("url") ?? "", title: route.query.get("title") ?? "" };
  return (
    <div className="page page-narrow">
      <PageHeader title="Add a bookmark" subtitle="Save any link. Paste its text too and it gets a summary, tags and full-text search." />
      {result && (
        <div className="banner banner-success add-result" role="status" data-testid="add-result">
          <span>
            <strong>{result.created ? "Added" : "Already saved — updated"}:</strong> {docTitle(result.doc)}
            {result.needs_content && <span className="add-result-detail">{NEEDS_CONTENT}</span>}
          </span>
          <button className="btn btn-sm" onClick={() => drawer.openDoc(result.doc.id)}>
            Open
          </button>
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => {
              setResult(null);
              setFormKey((k) => k + 1);
              history.replaceState(null, "", "#/add");
            }}
          >
            Add another
          </button>
        </div>
      )}
      {!result && (
        <div className="card card-pad">
          <AddDocForm key={formKey} prefill={prefill} onDone={setResult} />
        </div>
      )}
    </div>
  );
}
