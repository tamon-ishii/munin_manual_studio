export interface MarkitsCaptureWorkflow {
  alreadyInserted: boolean;
  dirty: boolean;
  importImage: () => Promise<string>;
  insertTag: (block: string) => void;
  saveDocument: () => Promise<void>;
  saveCaptureSource?: () => Promise<void>;
  refreshWorkspace: () => Promise<void>;
  reportStage: (stage: "image" | "document" | "capture-source" | "refresh") => void;
}

/** Runs each durable step in order and can safely resume after any failed step. */
export async function completeMarkitsCapture(workflow: MarkitsCaptureWorkflow): Promise<void> {
  let insertedNow = false;
  if (!workflow.alreadyInserted) {
    workflow.reportStage("image");
    const block = await workflow.importImage();
    workflow.insertTag(block);
    insertedNow = true;
  }
  if (insertedNow || workflow.dirty) {
    workflow.reportStage("document");
    await workflow.saveDocument();
  }
  if (workflow.saveCaptureSource) {
    workflow.reportStage("capture-source");
    await workflow.saveCaptureSource();
  }
  workflow.reportStage("refresh");
  await workflow.refreshWorkspace();
}
