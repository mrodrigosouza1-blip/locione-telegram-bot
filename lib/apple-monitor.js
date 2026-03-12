/**
 * Monitoramento de apps iOS via API pública da Apple.
 * Consulta itunes.apple.com/lookup e detecta mudanças de versão/nome/data.
 */

const APPLE_LOOKUP_URL = "https://itunes.apple.com/lookup";
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Busca dados de um app na App Store.
 * @param {string} appId - ID numérico do app (ex: "6758838032")
 * @param {string} [country="br"]
 * @returns {Promise<{ found: boolean, appId?: string, trackName?: string, version?: string, currentVersionReleaseDate?: string, trackViewUrl?: string, raw?: object }>}
 */
export async function fetchAppleApp(appId, country = "br") {
  const url = `${APPLE_LOOKUP_URL}?id=${encodeURIComponent(appId)}&country=${encodeURIComponent(country)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      return { found: false };
    }
    const data = await res.json();
    if (!data?.resultCount || !Array.isArray(data.results) || data.results.length === 0) {
      return { found: false };
    }
    const r = data.results[0];
    return {
      found: true,
      appId: String(r.trackId ?? r.bundleId ?? appId),
      trackName: r.trackName ?? null,
      version: r.version ?? null,
      currentVersionReleaseDate: r.currentVersionReleaseDate ?? null,
      trackViewUrl: r.trackViewUrl ?? null,
      raw: r,
    };
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === "AbortError") {
      console.error("[apple-check] fetch timeout", appId, e.message);
    } else {
      console.error("[apple-check] fetch error", appId, e?.message || e);
    }
    return { found: false };
  }
}

/**
 * Gera texto do post de atualização (texto puro, sem Markdown).
 */
export function formatUpdatePost({ appName, oldVersion, newVersion, newReleaseDate, storeUrl }) {
  const lines = [
    "Atualização disponível",
    "",
    appName || "App",
  ];
  if (oldVersion || newVersion) {
    lines.push(`Versão: ${oldVersion || "?"} → ${newVersion || "?"}`);
    lines.push("");
  }
  if (newReleaseDate) {
    lines.push(`Data: ${newReleaseDate}`);
    lines.push("");
  }
  lines.push("Baixar:");
  lines.push(storeUrl || "");
  return lines.join("\n");
}

const SEED_APPS = [
  {
    slug: "finance",
    name: "LociOne Finance",
    platform: "ios",
    app_id: "6758838032",
    country: "br",
    store_url: "https://apps.apple.com/it/app/locione-finance/id6758838032",
  },
  {
    slug: "office",
    name: "LociOne Office",
    platform: "ios",
    app_id: "6759913632",
    country: "br",
    store_url: "https://apps.apple.com/br/app/locione-office/id6759913632",
  },
  {
    slug: "tools",
    name: "LociTools",
    platform: "ios",
    app_id: "6760295235",
    country: "br",
    store_url: "https://apps.apple.com/br/app/locitools/id6760295235",
  },
];

/**
 * Garante que os apps iniciais existem em tracked_apps (insert só se não existir).
 */
export function seedTrackedApps(db) {
  const stmt = db.prepare(`
    INSERT INTO tracked_apps (slug, name, platform, app_id, country, store_url)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO NOTHING
  `);
  for (const app of SEED_APPS) {
    stmt.run(app.slug, app.name, app.platform, app.app_id, app.country, app.store_url);
  }
  console.log("[apple-monitor] seed ok");
}

/**
 * Checa um app monitorado: busca Apple, detecta mudanças, opcionalmente posta no canal e envia broadcast.
 * @param {object} db - instância better-sqlite3
 * @param {object} row - linha de tracked_apps
 * @param {object} [opts]
 * @param {function} [opts.postToChannelFn] - (text, kind, source) => Promise
 * @param {function} [opts.sendBroadcastFn] - (text) => Promise
 * @param {function} [opts.incStatFn] - (key) => void
 * @returns {Promise<{ ok: boolean, updated?: boolean, posted?: boolean, broadcastSent?: boolean, error?: string }>}
 */
export async function checkTrackedApp(db, row, opts = {}) {
  const { postToChannel = true, sendBroadcast = false, postToChannelFn, sendBroadcastFn, incStatFn } = opts;
  const slug = row.slug;
  const inc = (key) => {
    if (incStatFn) try { incStatFn(key); } catch (e) { console.error("incStat error:", e); }
  };

  const stmtUpdateChecked = db.prepare(`
    UPDATE tracked_apps SET last_checked_at = datetime('now') WHERE id = ?
  `);
  const stmtUpdateFull = db.prepare(`
    UPDATE tracked_apps
    SET last_version = ?, last_release_date = ?, last_name = ?, last_checked_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `);
  const stmtInsertUpdate = db.prepare(`
    INSERT INTO app_updates (tracked_app_id, slug, app_id, old_version, new_version, old_release_date, new_release_date, old_name, new_name, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtMarkPosted = db.prepare(`
    UPDATE app_updates SET posted_to_channel = 1 WHERE id = ?
  `);
  const stmtMarkBroadcast = db.prepare(`
    UPDATE app_updates SET broadcast_sent = 1 WHERE id = ?
  `);

  console.log("[apple-check] start", slug);

  const apple = await fetchAppleApp(row.app_id, row.country || "br");
  stmtUpdateChecked.run(row.id);

  if (!apple.found) {
    console.log("[apple-check] app not found", slug);
    return { ok: true, updated: false };
  }

  const newVersion = apple.version ?? null;
  const newReleaseDate = apple.currentVersionReleaseDate ?? null;
  const newName = apple.trackName ?? null;
  const storeUrl = apple.trackViewUrl || row.store_url || "";

  const firstSync = (row.last_version == null || row.last_version === "") &&
    (row.last_release_date == null || row.last_release_date === "");
  if (firstSync) {
    stmtUpdateFull.run(newVersion, newReleaseDate, newName, row.id);
    console.log("[apple-check] first sync", slug, "version", newVersion);
    return { ok: true, updated: false };
  }

  const versionChanged = (row.last_version || "") !== (newVersion || "");
  const releaseDateChanged = (row.last_release_date || "") !== (newReleaseDate || "");
  const nameChanged = (row.last_name || "") !== (newName || "");
  const relevantChange = versionChanged || releaseDateChanged || nameChanged;

  if (!relevantChange) {
    console.log("[apple-check] no change", slug);
    return { ok: true, updated: false };
  }

  console.log("[apple-check] update detected", slug, (row.last_version || "?") + " -> " + (newVersion || "?"));

  const rawJson = apple.raw ? JSON.stringify(apple.raw) : null;
  stmtInsertUpdate.run(
    row.id,
    slug,
    row.app_id,
    row.last_version,
    newVersion,
    row.last_release_date,
    newReleaseDate,
    row.last_name,
    newName,
    rawJson
  );
  const updateId = db.prepare("SELECT last_insert_rowid() as id").get().id;
  inc("app_update_detected");

  stmtUpdateFull.run(newVersion, newReleaseDate, newName, row.id);

  const postText = formatUpdatePost({
    appName: newName || row.name,
    oldVersion: row.last_version,
    newVersion,
    newReleaseDate,
    storeUrl,
  });
  const postTextWithEmoji = "🚀 " + postText;

  let posted = false;
  let broadcastSent = false;

  if (postToChannel && postToChannelFn) {
    try {
      await postToChannelFn(postTextWithEmoji, slug, "app_update");
      stmtMarkPosted.run(updateId);
      inc("app_update_channel_posted");
      posted = true;
      console.log("[apple-check] post channel ok", slug);
    } catch (e) {
      console.error("[apple-check] post channel failed", slug, e?.message || e);
    }
  } else if (postToChannel && !postToChannelFn) {
    console.log("[apple-check] broadcast skipped (no fn)", slug);
  }

  if (sendBroadcast && sendBroadcastFn) {
    try {
      await sendBroadcastFn(postTextWithEmoji);
      stmtMarkBroadcast.run(updateId);
      inc("app_update_broadcast_sent");
      broadcastSent = true;
      console.log("[apple-check] broadcast sent", slug);
    } catch (e) {
      console.error("[apple-check] broadcast failed", slug, e?.message || e);
    }
  } else if (sendBroadcast && !sendBroadcastFn) {
    console.log("[apple-check] broadcast skipped (no fn)", slug);
  } else {
    console.log("[apple-check] broadcast skipped", slug);
  }

  return { ok: true, updated: true, posted, broadcastSent };
}

/**
 * Lista todos os apps em tracked_apps.
 */
export function listTrackedApps(db) {
  const stmt = db.prepare(`
    SELECT id, slug, name, platform, app_id, country, store_url, is_active, last_version, last_release_date, last_name, last_checked_at, created_at
    FROM tracked_apps
    ORDER BY slug ASC
  `);
  return stmt.all();
}

/**
 * Apps ativos para o job (platform = ios).
 */
export function getActiveTrackedApps(db) {
  const stmt = db.prepare(`
    SELECT id, slug, name, platform, app_id, country, store_url, is_active, last_version, last_release_date, last_name, last_checked_at
    FROM tracked_apps
    WHERE is_active = 1 AND platform = 'ios'
    ORDER BY slug ASC
  `);
  return stmt.all();
}

/**
 * Busca app por slug.
 */
export function getTrackedAppBySlug(db, slug) {
  const stmt = db.prepare(`
    SELECT id, slug, name, platform, app_id, country, store_url, is_active, last_version, last_release_date, last_name, last_checked_at
    FROM tracked_apps WHERE slug = ?
  `);
  return stmt.get(slug);
}

/**
 * Adiciona um app para monitoramento.
 */
export function addTrackedApp(db, { slug, name, appId, country = "br", storeUrl }) {
  const stmt = db.prepare(`
    INSERT INTO tracked_apps (slug, name, platform, app_id, country, store_url)
    VALUES (?, ?, 'ios', ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      name = excluded.name,
      app_id = excluded.app_id,
      country = excluded.country,
      store_url = excluded.store_url,
      updated_at = datetime('now')
  `);
  stmt.run(slug.trim().toLowerCase(), name.trim(), String(appId).trim(), country.trim().toLowerCase(), storeUrl ? storeUrl.trim() : null);
}

/**
 * Alterna is_active (0 <-> 1) por slug.
 */
export function toggleTrackedApp(db, slug) {
  const stmt = db.prepare(`
    UPDATE tracked_apps SET is_active = 1 - is_active, updated_at = datetime('now') WHERE slug = ?
  `);
  const res = stmt.run(slug.trim().toLowerCase());
  if (res.changes === 0) return null;
  const row = db.prepare("SELECT is_active FROM tracked_apps WHERE slug = ?").get(slug.trim().toLowerCase());
  return row ? row.is_active === 1 : null;
}

/**
 * Últimos N registros de app_updates.
 */
export function getLastAppUpdates(db, limit = 10) {
  const stmt = db.prepare(`
    SELECT id, slug, app_id, old_version, new_version, old_release_date, new_release_date, old_name, new_name, detected_at, posted_to_channel, broadcast_sent
    FROM app_updates
    ORDER BY detected_at DESC
    LIMIT ?
  `);
  return stmt.all(limit);
}

let jobRunning = false;

/**
 * Executa check em todos os apps ativos (ios). Um por vez com delay.
 * Se um ciclo já estiver rodando, retorna sem fazer nada.
 */
export async function runAllChecks(db, opts = {}) {
  if (jobRunning) {
    console.log("[apple-check] skip (job already running)");
    return { skipped: true, checked: 0 };
  }
  jobRunning = true;
  const delayMs = opts.delayMs ?? 2000;
  const { postToChannelFn, sendBroadcastFn, incStatFn } = opts;

  try {
    const apps = getActiveTrackedApps(db);
    console.log("[apple-check] job start, apps:", apps.length);

    let checked = 0;
    for (const row of apps) {
      try {
        await checkTrackedApp(db, row, {
          postToChannel: true,
          sendBroadcast: false,
          postToChannelFn,
          sendBroadcastFn,
          incStatFn,
        });
        checked++;
      } catch (e) {
        console.error("[apple-check] error", row.slug, e?.message || e);
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }

    console.log("[apple-check] job end, checked:", checked);
    return { skipped: false, checked };
  } finally {
    jobRunning = false;
  }
}
