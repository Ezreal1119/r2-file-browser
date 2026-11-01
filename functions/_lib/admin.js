export function isAdminPassword(value, env) {
  const expected = env?.ADMIN_PASSWORD;
  return typeof expected === "string" && expected.length > 0 && typeof value === "string" && value === expected;
}
