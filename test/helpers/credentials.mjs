// Fake credentials for isolated tests only, never production defaults.
export const ADMIN_PASSWORD = "test-only-admin-password";
export const UPLOADER_PASSWORD = "test-only-uploader-password";
export const TEST_AUTH_ENV = { ADMIN_PASSWORD, UPLOADER_PASSWORD };
