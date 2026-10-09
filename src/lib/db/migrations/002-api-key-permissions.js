// v2: migrate the fork's legacy allowedModels column into upstream's access
// columns, preserve expiry, and add key presets. New databases already have the
// access columns from TABLES; old databases receive them here.
export default {
  version: 2,
  name: "api-key-permissions",
  up(db) {
    const cols = db.all(`PRAGMA table_info(apiKeys)`).map((r) => r.name);
    // Version 3 completes the data migration for databases that already ran
    // the original fork v2 migration; v2 handles fresh upgrades from v1.
    if (!cols.includes("accessRestricted")) db.exec(`ALTER TABLE apiKeys ADD COLUMN accessRestricted INTEGER DEFAULT 0`);
    if (!cols.includes("accessAllow")) db.exec(`ALTER TABLE apiKeys ADD COLUMN accessAllow TEXT`);
    if (!cols.includes("expiresAt")) db.exec(`ALTER TABLE apiKeys ADD COLUMN expiresAt TEXT`);

    // Fork-only column: fold any existing allow-list into the access columns so
    // stored keys keep working after the upgrade to upstream's model.
    if (cols.includes("allowedModels")) {
      for (const row of db.all(`SELECT id, allowedModels FROM apiKeys`)) {
        let allow = [];
        try {
          const parsed = row.allowedModels ? JSON.parse(row.allowedModels) : null;
          if (Array.isArray(parsed)) allow = parsed.filter((m) => typeof m === "string" && m.trim());
        } catch { /* malformed legacy data becomes unrestricted */ }
        db.run(`UPDATE apiKeys SET accessRestricted = ?, accessAllow = ? WHERE id = ?`, [allow.length > 0 ? 1 : 0, JSON.stringify(allow), row.id]);
      }
    }
    db.exec(
      `CREATE TABLE IF NOT EXISTS keyPresets(
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        models TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )`
    );
  },
};
