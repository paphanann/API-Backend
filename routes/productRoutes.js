const express = require("express");
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
  return `${publicOrigin(req)}/api/products/image?url=${encodeURIComponent(imageUrl)}`;
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

async function attachSapItemCodes(row) {
  if (!sapService.isConfigured()) return row;
  try {
    const mapped = await sapService.mapProduct({
      platform: row.Platform,
      productId: row.ProductId,
      sku: row.Sku,
      name: row.Name,
      variants: row.variants || row.Variants || [],
    });
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
    const mapped = [];
    for (const row of rows) {
      mapped.push(withPublicFields(req, await attachSapItemCodes(row)));
    }
    res.json(mapped);
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
    if (!isAllowedImageHost(host)) {
      return res.status(403).json({ message: "host not allowed" });
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
