// v3: complete migration for databases that already ran the fork's v2
// allowedModels migration before upstream added access columns.
export default {
  version: 3,
  name: "migrate-allowed-models-to-access",
  up(db) {
    const cols = db.all(`PRAGMA table_info(apiKeys)`).map((r) => r.name);
    if (!cols.includes("accessRestricted")) db.exec(`ALTER TABLE apiKeys ADD COLUMN accessRestricted INTEGER DEFAULT 0`);
    if (!cols.includes("accessAllow")) db.exec(`ALTER TABLE apiKeys ADD COLUMN accessAllow TEXT`);
    if (!cols.includes("expiresAt")) db.exec(`ALTER TABLE apiKeys ADD COLUMN expiresAt TEXT`);
    if (!cols.includes("allowedModels")) return;

    for (const row of db.all(`SELECT id, allowedModels FROM apiKeys`)) {
      let allow = [];
      try {
        const parsed = row.allowedModels ? JSON.parse(row.allowedModels) : null;
        if (Array.isArray(parsed)) allow = parsed.filter((m) => typeof m === "string" && m.trim());
      } catch { /* malformed legacy data becomes unrestricted */ }
      db.run(`UPDATE apiKeys SET accessRestricted = ?, accessAllow = ? WHERE id = ?`, [allow.length > 0 ? 1 : 0, JSON.stringify(allow), row.id]);
    }
  },
};
