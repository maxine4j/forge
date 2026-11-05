import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

// DatabaseSync stays entirely off the HTTP event loop. Messages are processed serially.
const database = new DatabaseSync(workerData.path, {
	enableForeignKeyConstraints: true,
	enableDoubleQuotedStringLiterals: false,
});
database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
parentPort!.postMessage({ ready: true });
parentPort!.on("message", (message) => {
	try {
		if (message.op === "close") {
			database.close();
			parentPort!.postMessage({ id: message.id, result: undefined });
			parentPort!.close();
			return;
		}
		if (message.op === "transaction") {
			database.exec("BEGIN IMMEDIATE");
			try {
				for (const statement of message.statements)
					database.prepare(statement.sql).run(...(statement.parameters ?? []));
				database.exec("COMMIT");
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
			parentPort!.postMessage({ id: message.id, result: undefined });
			return;
		}
		const statement = database.prepare(message.sql);
		let result: unknown;
		if (message.op === "all") {
			const rows = [];
			for (const row of statement.iterate(...message.parameters)) {
				rows.push(row);
				if (rows.length > 1000) throw new Error("Database result exceeds row limit");
			}
			result = rows;
		} else result = Number(statement.run(...message.parameters).changes);
		parentPort!.postMessage({ id: message.id, result });
	} catch (error) {
		parentPort!.postMessage({ id: message.id, error: error instanceof Error ? error.message : "SQLite failure" });
	}
});
