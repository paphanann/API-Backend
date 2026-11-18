const express = require("express");
const sharp = require("sharp");
const router = express.Router();

const { normalizePlatform } = require("../utils/platform");
const productStore = require("../services/stores/productStore");
const sapService = require("../services/marketplaces/sapService");

function absoluteHttps(url) {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed || trimmed === "-") return null;
  if (/^https:\/\//i.test(trimmed)) return trimmed;
  if (/^http:\/\//i.test(trimmed)) return trimmed.replace(/^http:/i, "https:");
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return null;
}

function publicOrigin(req) {
  const forwarded = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const host = String(req.headers["x-forwarded-host"] || req.get("host") || "")
    .split(",")[0]
    .trim();
  const local = host.startsWith("localhost") || host.startsWith("127.0.0.1");
  const proto = local ? forwarded || req.protocol || "http" : "https";
  return `${proto}://${host}`;
}

function proxyImageUrl(req, url) {
  const imageUrl = absoluteHttps(url);
  if (!imageUrl) return null;
  return `${publicOrigin(req)}/api/products/image?url=${encodeURIComponent(imageUrl)}&w=160`;
}

const THUMB_CACHE_BYTES = 32 * 1024 * 1024;
const thumbCache = new Map();
let thumbBytes = 0;
const thumbInflight = new Map();

function thumbWidth(value) {
  const n = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(n)) return 0;
  return Math.min(512, Math.max(32, n));
}

function cdnThumb(url, width) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if ((host.includes("shopee") || host.includes("susercontent")) && parsed.pathname.includes("/file/") && !parsed.pathname.includes("@resize")) {
      return `${parsed.origin}${parsed.pathname}@resize_w${width}_nl`;
    }
    if ((host.includes("slatic") || host.includes("lazcdn")) && !/_\d+x\d+q\d+/i.test(parsed.pathname)) {
      return `${url}_${width}x${width}q80.jpg_.webp`;
    }
  } catch {
    return url;
  }
  return url;
}

function rememberThumb(key, value) {
  const prev = thumbCache.get(key);
  if (prev) {
    thumbBytes -= prev.buf.length;
    thumbCache.delete(key);
  }
  thumbCache.set(key, value);
  thumbBytes += value.buf.length;
  while (thumbBytes > THUMB_CACHE_BYTES && thumbCache.size > 1) {
    const oldest = thumbCache.keys().next().value;
    thumbBytes -= thumbCache.get(oldest).buf.length;
    thumbCache.delete(oldest);
  }
}

async function fetchImage(target) {
  const upstream = await fetch(target, {
    headers: imageFetchHeaders(target),
    redirect: "follow",
  });
  if (!upstream.ok) return null;
  const type = String(upstream.headers.get("content-type") || "");
  if (!type.toLowerCase().startsWith("image/")) return null;
  const buf = Buffer.from(await upstream.arrayBuffer());
  if (!buf.length) return null;
  return { buf, type };
}

async function loadThumb(target, width) {
  const key = `${width}\0${target}`;
  const hit = thumbCache.get(key);
  if (hit) {
    thumbCache.delete(key);
    thumbCache.set(key, hit);
    return hit;
  }
  if (thumbInflight.has(key)) return thumbInflight.get(key);

  const job = (async () => {
    const thumbUrl = cdnThumb(target, width);
    let image = thumbUrl === target ? null : await fetchImage(thumbUrl);
    if (!image) image = await fetchImage(target);
    if (!image) return null;
    let { buf, type } = image;
    if (buf.length > 24 * 1024) {
      try {
        buf = await sharp(buf, { failOn: "none" }).rotate().resize({ width, withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
        type = "image/jpeg";
      } catch (error) {
        console.error("thumb resize failed:", error.message);
      }
    }
    const value = { buf, type };
    rememberThumb(key, value);
    return value;
  })().finally(() => {
    thumbInflight.delete(key);
  });
  thumbInflight.set(key, job);
  return job;
}

function isAllowedImageHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return (
    host.includes("shopee") ||
    host.includes("susercontent") ||
    host.includes("lazada") ||
    host.includes("lazcdn") ||
    host.includes("slatic") ||
    host.includes("alicdn") ||
    host.includes("tiktok") ||
    host.includes("tiktokcdn") ||
    host.includes("byteimg") ||
    host.includes("ibyteimg") ||
    host.includes("bytedance") ||
    host.includes("byteoversea") ||
    host.includes("muscdn") ||
    host.includes("ibyte") ||
    host.includes("ibb.co") ||
    host.endsWith(".mzstatic.com")
  );
}

function imageFetchHeaders(target) {
  const host = new URL(target).hostname.toLowerCase();
  let referer = "https://www.google.com/";
  if (host.includes("shopee") || host.includes("susercontent")) {
    referer = "https://shopee.co.th/";
  } else if (host.includes("lazada") || host.includes("lazcdn") || host.includes("slatic")) {
    referer = "https://www.lazada.co.th/";
  } else if (host.includes("tiktok") || host.includes("byte") || host.includes("muscdn")) {
    referer = "https://shop.tiktok.com/";
  }
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    Referer: referer,
  };
}

function withPublicFields(req, row) {
  const variants = Array.isArray(row.Variants)
    ? row.Variants
    : Array.isArray(row.variants)
      ? row.variants
      : [];

  const rawImage =
    row.ImageUrl ||
    row.imageUrl ||
    variants.map((v) => v.ImageUrl || v.imageUrl).find(Boolean) ||
    null;
  const image = proxyImageUrl(req, rawImage);
  const mappedVariants = variants.map((v) => {
    const variantImage = proxyImageUrl(req, v.ImageUrl || v.imageUrl || rawImage);
    const sapItemCode = v.sapItemCode || v.SapItemCode || null;
    const problem = v.problem || (sapItemCode ? null : "ไม่พบสินค้าใน SAP");
    const statusProblem = v.statusProblem || (sapItemCode ? "พร้อมขาย" : "ไม่พบสินค้าใน SAP");
    return {
      ...v,
      ImageUrl: variantImage,
      imageUrl: variantImage,
      sapItemCode,
      SapItemCode: sapItemCode,
      mapping: sapItemCode ? "Mapped" : "Not Mapped",
      problem,
      statusProblem,
    };
  });
  const codes = [...new Set(mappedVariants.map((v) => v.sapItemCode).filter(Boolean))];
  const sapItemCode =
    codes.length === 1 && mappedVariants.every((v) => v.sapItemCode)
      ? codes[0]
      : row.sapItemCode || row.SapItemCode || null;
  const unmappedCount = mappedVariants.length
    ? mappedVariants.filter((variant) => !variant.sapItemCode).length
    : sapItemCode
      ? 0
      : 1;

  return {
    ...row,
    ImageUrl: image,
    imageUrl: image,
    Variants: mappedVariants,
    variants: mappedVariants,
    sapItemCode,
    SapItemCode: sapItemCode,
    mapping: sapItemCode ? "Mapped" : "Not Mapped",
    problem: unmappedCount ? "ไม่พบสินค้าใน SAP" : null,
    statusProblem:
      unmappedCount === 0
        ? "พร้อมขาย"
        : unmappedCount === mappedVariants.length
          ? "ไม่พบสินค้าใน SAP"
          : "บางรุ่นไม่พบสินค้าใน SAP",
  };
}

async function attachSapItemCodes(row, catalog) {
  if (!sapService.isConfigured() || !catalog) return row;
  try {
    const mapped = await sapService.mapProduct(
      {
        platform: row.Platform,
        productId: row.ProductId,
        sku: row.Sku,
        name: row.Name,
        variants: row.variants || row.Variants || [],
      },
      catalog
    );
    return {
      ...row,
      variants: mapped.variants,
      Variants: mapped.variants,
      sapItemCode: mapped.sapItemCode,
    };
  } catch (error) {
    console.error(error);
    return row;
  }
}

router.get("/", async (req, res) => {
  try {
    const platform = normalizePlatform(req.query.platform);
    const rows = await productStore.listProducts(platform);

    let catalog = null;

    if (sapService.isConfigured()) {
      try {
        catalog = await sapService.catalogIndex();
      } catch (error) {
        console.error(
          "SAP catalog unavailable:",
          error.message
        );
      }
    }

    const mapped = [];

    for (const row of rows) {
      mapped.push(
        withPublicFields(
          req,
          await attachSapItemCodes(row, catalog)
        )
      );
    }

    res.json(mapped);
  } catch (error) {
    console.error("Products API error:", error);

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
    if (!isAllowedImageHost(host)) {
      return res.status(403).json({ message: "host not allowed" });
    }

    const width = thumbWidth(req.query.w);
    if (width) {
      const image = await loadThumb(target, width);
      if (!image) {
        return res.status(502).json({ message: "upstream image failed" });
      }
      res.setHeader("Content-Type", image.type);
      res.setHeader("Cache-Control", "public, max-age=604800");
      return res.send(image.buf);
    }

    const upstream = await fetch(target, {
      headers: imageFetchHeaders(target),
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
