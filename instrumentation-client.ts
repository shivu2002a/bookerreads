import { installClientErrorHandlers } from "@/lib/observability/client-errors";

// Deliberately not Sentry.init(): the client SDK is loaded lazily on the first
// error to protect the 150 KB member-route budget (see lib/observability).
installClientErrorHandlers();
