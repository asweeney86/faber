import { PbClient } from "@faber/shared";

/** A daemon client for extension code: reads go out as POST so Chrome attaches our Origin. */
export function daemonClient(daemonUrl: string): PbClient {
  return new PbClient(daemonUrl, { identifyReads: true });
}
