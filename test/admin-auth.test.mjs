import assert from "node:assert/strict";
import test from "node:test";
import { isAdminPassword } from "../functions/_lib/admin.js";
import { isUploaderPassword } from "../functions/_lib/uploader.js";
import { onRequestPost } from "../functions/api/admin.js";

test("management passwords fail closed without configured Secrets and have no built-in defaults", async () => {
  for (const env of [undefined, {}, { ADMIN_PASSWORD: "", UPLOADER_PASSWORD: "" }]) {
    for (const value of [undefined, "", "test-only-admin-password", "test-only-uploader-password"]) {
      assert.equal(isAdminPassword(value, env), false);
      assert.equal(isUploaderPassword(value, env), false);
      const result = await onRequestPost({ env, request: new Request("https://example.com/api/admin", {
        method: "POST", body: JSON.stringify({ password: value }),
      }) });
      assert.equal(result.status, 401);
    }
  }
  assert.equal(isAdminPassword("new-password", { ADMIN_PASSWORD: "new-password" }), true);
  assert.equal(isUploaderPassword("new-password", { UPLOADER_PASSWORD: "new-password" }), true);
  assert.equal(isAdminPassword("old-password", { ADMIN_PASSWORD: "new-password" }), false);
});
