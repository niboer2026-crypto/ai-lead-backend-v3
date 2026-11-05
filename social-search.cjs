Const express = require("express");

module.exports = function createSocialSearchModule(db, runningAccounts) {
  const router = express.Router();

  db.exec(`
    CREATE TABLE IF NOT EXISTS social_search_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      platform TEXT NOT NULL,
      country TEXT DEFAULT '',
      city TEXT DEFAULT '',
      keywords TEXT NOT NULL,
      gender TEXT DEFAULT '不限',
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const clean = (v, max = 200) =>
    String(v ?? "").trim().slice(0, max);

  const validPlatforms = [
    "Facebook",
    "Instagram",
    "TikTok"
  ];

  const validGenders = [
    "不限",
    "男性",
    "女性"
  ];

  // 获取搜索设置
  router.get("/", (req, res) => {
    const rows = db.prepare(`
      SELECT * FROM social_search_configs
      ORDER BY id DESC
    `).all();

    res.json(rows);
  });

  // 创建搜索设置
  router.post("/", (req, res) => {
    const b = req.body || {};

    const accountId = Number(b.account_id);
    const platform = clean(b.platform, 30);
    const country = clean(b.country, 100);
    const city = clean(b.city, 100);
    const keywords = clean(b.keywords, 1000);
    const gender = clean(b.gender || "不限", 20);

    if (!accountId || !validPlatforms.includes(platform)) {
      return res.status(400).json({
        error: "账号或平台无效"
      });
    }

    if (!keywords) {
      return res.status(400).json({
        error: "请填写搜索关键词"
      });
    }

    if (!validGenders.includes(gender)) {
      return res.status(400).json({
        error: "性别设置无效"
      });
    }

    const account = db.prepare(`
      SELECT * FROM social_accounts WHERE id = ?
    `).get(accountId);

    if (!account || account.platform !== platform) {
      return res.status(404).json({
        error: "找不到对应的平台账号"
      });
    }

    const result = db.prepare(`
      INSERT INTO social_search_configs
      (account_id, platform, country, city, keywords, gender)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      accountId,
      platform,
      country,
      city,
      keywords,
      gender
    );

    res.json({
      ok: true,
      id: result.lastInsertRowid
    });
  });

  // 删除搜索设置
  router.delete("/:id", (req, res) => {
    const result = db.prepare(`
      DELETE FROM social_search_configs WHERE id = ?
    `).run(Number(req.params.id));

    res.json({
      ok: result.changes > 0
    });
  });

  // 启用或停用搜索设置
  router.patch("/:id", (req, res) => {
    const enabled = req.body.enabled ? 1 : 0;

    const result = db.prepare(`
      UPDATE social_search_configs
      SET enabled = ?
      WHERE id = ?
    `).run(enabled, Number(req.params.id));

    res.json({
      ok: result.changes > 0
    });
  });

  // 执行搜索：打开对应账号的独立浏览器
  router.post("/:id/run", async (req, res) => {
    try {
      const config = db.prepare(`
        SELECT
          s.*,
          a.profile_id,
          a.label
        FROM social_search_configs s
        JOIN social_accounts a
          ON s.account_id = a.id
        WHERE s.id = ?
      `).get(Number(req.params.id));

      if (!config) {
        return res.status(404).json({
          error: "搜索任务不存在"
        });
      }

      if (!config.enabled) {
        return res.status(400).json({
          error: "这个搜索任务已停用"
        });
      }

      const account = runningAccounts.get(
        config.profile_id
      );

      if (!account) {
        return res.status(400).json({
          error: "请先启动对应账号的独立浏览器"
        });
      }

      const query = [
        config.keywords,
        config.city,
        config.country
      ].filter(Boolean).join(" ");

      const encoded = encodeURIComponent(query);

      const searchUrls = {
        Facebook:
          `https://www.facebook.com/search/top?q=${encoded}`,

        Instagram:
          `https://www.instagram.com/explore/search/keyword/?q=${encoded}`,

        TikTok:
          `https://www.tiktok.com/search?q=${encoded}`
      };

      const url = searchUrls[config.platform];

      await account.page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60000
      });

      res.json({
        ok: true,
        platform: config.platform,
        account: config.label,
        country: config.country,
        city: config.city,
        keywords: config.keywords,
        gender: config.gender,
        url,
        notice:
          "已打开平台搜索页面。性别条件目前仅保存，不代表平台已按性别筛选结果。"
      });

    } catch (error) {
      res.status(500).json({
        error: error.message
      });
    }
  });

  return router;
};
