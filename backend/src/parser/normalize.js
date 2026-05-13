// Turn classified Postmark attachments into Anthropic content blocks.
// Pure JS; no API calls.
//
// Postmark base64-encodes the file in `Content`; `ContentLength` is decoded bytes.
// 5MB per-attachment cap is plenty for real receipts (typical PDFs are <500KB).

const SIZE_LIMIT_BYTES = 5 * 1024 * 1024;

export function buildContentBlocks(attachments) {
  const blocks = [];
  const oversize = [];
  for (const att of attachments) {
    if (typeof att.Content !== "string" || att.Content.length === 0) continue;
    if (typeof att.ContentLength === "number" && att.ContentLength > SIZE_LIMIT_BYTES) {
      oversize.push({ name: att.Name, bytes: att.ContentLength });
      continue;
    }
    if (att._kind === "pdf") {
      blocks.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: att.Content,
        },
      });
    } else if (att._kind === "image") {
      const mediaType = att.ContentType.split(";")[0].trim().toLowerCase();
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data: att.Content,
        },
      });
    }
  }
  return { blocks, oversize };
}
