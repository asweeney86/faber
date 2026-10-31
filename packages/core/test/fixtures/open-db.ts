// Helper for upgrade.test.ts: open (and so migrate) the database at argv[2], then exit.
import { openDatabase } from "../../src/db";
openDatabase(process.argv[2]!).close();
