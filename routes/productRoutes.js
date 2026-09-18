const express = require("express");
const router = express.Router();

const { normalizePlatform } = require("../utils/platform");
const productStore = require("../services/productStore");

function absoluteHttps(url) {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed || trimmed === "-") return null;
  if (/^https:\/\//i.test(trimmed)) return trimmed;
  if (/^http:\/\//i.test(trimmed)) return trimmed.replace(/^http:/i, "https:");
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return null;
}

function proxyImageUrl(req, url) {
  const imageUrl = absoluteHttps(url);
  if (!imageUrl) return null;
  const host = `${req.protocol}://${req.get("host")}`;
  return `${host}/api/products/image?url=${encodeURIComponent(imageUrl)}`;
}

function withPublicFields(req, row) {
  const variants = Array.isArray(row.Variants)
    ? row.Variants
    : Array.isArray(row.variants)
      ? row.variants
      : [];

  return {
    ...row,
    ImageUrl: proxyImageUrl(req, row.ImageUrl || row.imageUrl),
    Variants: variants.map((v) => ({
      ...v,
      ImageUrl: proxyImageUrl(req, v.ImageUrl || v.imageUrl),
      imageUrl: proxyImageUrl(req, v.ImageUrl || v.imageUrl),
    })),
  };
}

router.get("/", async (req, res) => {
  try {
    const platform = normalizePlatform(req.query.platform);
    const rows = await productStore.listProducts(platform);
    res.json(rows.map((row) => withPublicFields(req, row)));
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "ไม่สามารถดึงสินค้าได้",
    });
  }
});

/** Proxy marketplace CDNs so Flutter web can load images without CORS issues */
router.get("/image", async (req, res) => {
  try {
    const target = absoluteHttps(String(req.query.url || ""));
    if (!target) {
      return res.status(400).json({ message: "url required" });
    }

    const host = new URL(target).hostname.toLowerCase();
    const allowed =
      host.includes("shopee") ||
      host.includes("lazada") ||
      host.includes("tiktok") ||
      host.includes("bytedance") ||
      host.includes("ibyteimg") ||
      host.includes("byteimg") ||
      host.includes("slatic") ||
      host.includes("alicdn") ||
      host.includes("ibb.co") ||
      host.endsWith(".mzstatic.com");

    if (!allowed) {
      return res.status(403).json({ message: "host not allowed" });
    }

    const upstream = await fetch(target, {
      headers: { "User-Agent": "PASS-Backend-ImageProxy/1.0", Accept: "image/*" },
      redirect: "follow",
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({ message: "upstream image failed" });
    }

    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.send(buf);
  } catch (error) {
    console.error(error);
    return res.status(502).json({ message: "image proxy failed" });
  }
});

module.exports = router;
