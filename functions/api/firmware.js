import { isUploader, uploaderJson as json } from "../_lib/uploader.js";
import { FirmwareError, firmwareConfig, findFirmware, startFirmware, getFirmwareJob } from "../_lib/firmware.js";

export async function onRequest(context) {
  if (!(await isUploader(context.request, context.env))) return json({ error: "Unlock Admin or Uploader mode to use this feature." }, 401);
  const url = new URL(context.request.url);
  const action = url.searchParams.get("action");
  if (context.request.method === "GET" && action === "config") return json({ available: Boolean(firmwareConfig(context.env)) });
  if (!firmwareConfig(context.env)) return json({ error: "Firmware service is not configured." }, 503);
  try {
    if (context.request.method === "GET" && action === "find") return json(await findFirmware(context, Object.fromEntries(url.searchParams)));
    if (context.request.method === "GET" && action === "status") return json(await getFirmwareJob(context, url.searchParams.get("id")));
    if (context.request.method === "POST" && action === "start") {
      let input;
      try { input = await context.request.json(); } catch { return json({ error: "Invalid request." }, 400); }
      return json(await startFirmware(context, input || {}));
    }
    return json({ error: "Method not allowed." }, 405);
  } catch (error) {
    if (error instanceof FirmwareError) return json({ error: error.message }, error.status);
    console.error("Firmware request failed.");
    return json({ error: "Firmware request could not be completed. Please retry." }, 503);
  }
}
