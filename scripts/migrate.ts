import { openDb } from "../src/lib/db";
import { env } from "../src/lib/env";

openDb();
console.log(`Database ready at ${env.databasePath}`);
