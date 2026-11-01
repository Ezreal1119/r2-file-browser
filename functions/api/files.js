import {
  EXTERNAL_STATUS_KEY,
  filterLibraryFiles,
  listLibraryFiles,
  PREFIX,
} from "../_lib/files.js";
import { scopedLibraryFiles } from "../_lib/uploader.js";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "Vary": "X-Uploader-Token",
    },
  });
}

export async function onRequestGet(context) {
  try {
    const bucket = context.env.FIRMWARE_BUCKET;
    const requestUrl = new URL(
      context.request?.url || "https://local.invalid/api/files",
    );
    const query =
      requestUrl.searchParams.get("query") ||
      requestUrl.searchParams.get("key_word") ||
      "";
    const match = requestUrl.searchParams.get("match") === "and" ? "and" : "or";

    if (!bucket) {
      return jsonResponse(
        {
          error: "R2 binding FIRMWARE_BUCKET is not configured.",
        },
        500,
      );
    }

    const [files, statusObject] = await Promise.all([
      scopedLibraryFiles(context),
      bucket.get(EXTERNAL_STATUS_KEY),
    ]);
    let sync = null;

    if (statusObject) {
      try {
        const status = await statusObject.json();
        sync = {
          state: typeof status.state === "string" ? status.state : null,
          completedAt:
            typeof status.completedAt === "string"
              ? status.completedAt
              : null,
        };
      } catch {
        sync = null;
      }
    }

    const filteredFiles = filterLibraryFiles(files, query, match);

    return jsonResponse({
      prefix: PREFIX,
      count: filteredFiles.length,
      totalCount: files.length,
      query,
      match,
      sync,
      files: filteredFiles.map(
        ({
          key,
          name,
          size,
          uploaded,
          etag,
          url,
          hasDescription,
          description,
          source,
          external,
          displayPath,
          product,
          category,
          documentType,
          language,
          sourcePageUrl,
          sourceUpdatedAt,
          labels,
          descriptionOverridden,
          originType,
        }) => ({
          key,
          name,
          size,
          uploaded,
          etag,
          url,
          hasDescription: Boolean(hasDescription),
          description: description || "",
          source,
          external: Boolean(external),
          displayPath,
          product,
          category,
          documentType,
          language,
          sourcePageUrl,
          sourceUpdatedAt,
          labels: Array.isArray(labels) ? labels : [],
          descriptionOverridden: Boolean(descriptionOverridden),
          ...(originType ? { originType } : {}),
        }),
      ),
    });
  } catch (error) {
    console.error("Failed to list R2 files:", error);

    return jsonResponse(
      {
        error: "Failed to load files from R2.",
        detail: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
}
