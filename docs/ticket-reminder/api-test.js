const crypto = require("crypto");

// ============================================================
//  CONFIG — Điền thông tin của bạn vào đây
// ============================================================
const CONFIG = {
  HOST: "https://ticket.vnggames.net",       // Base host
  CLIENT_ID: "STORE",         // client_id
  CLIENT_SECRET: "gIoAAEm9IfUCDRwgIkqz7z0dMQ3Ov41R", // client_secret

  ENDPOINT: "/tickets/41654/comments",
  METHOD: "GET",

  QUERY_PARAMS: {
    requestUser: "minhgv",
    // --- Array params ---
    //service_ids: ["53", "22", "15", "54"],               // Để [] nếu không lọc
    //statuses: ["PENDING"],  // Để [] nếu không lọc

    // --- String / number params ---
    created_at_from: "",               // VD: "2024-01-01"
    created_at_to: "",                 // VD: "2024-12-31"
    assignee: "",                      // VD: "john.doe"
    //per_page: 20,                      // 1–100, mặc định 20
    //page: 1,                           // mặc định 1
  },
};
// ============================================================

const BASE_URL = `${CONFIG.HOST}/integration/v1`;

// ---------- Helpers ----------

function sha1(str) {
  return crypto.createHash("sha1").update(str, "utf8").digest("hex");
}

function htmlEntityDecode(str) {
  return String(str)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

/**
 * PHP array_filter() default (không callback):
 * Loại bỏ tất cả falsy values: false, 0, 0.0, "0", "", null, []
 * Giữ lại index gốc (sparse array) → json_encode ra object nếu sparse
 */
function phpArrayFilter(arr) {
  const result = {};
  arr.forEach((v, i) => {
    // Falsy trong PHP: null, false, 0, 0.0, "", "0", []
    if (
      v !== null &&
      v !== undefined &&
      v !== false &&
      v !== 0 &&
      v !== 0.0 &&
      v !== "" &&
      v !== "0" &&
      !(Array.isArray(v) && v.length === 0)
    ) {
      result[i] = v; // Giữ nguyên index gốc → giống PHP
    }
  });
  return result;
}

/**
 * PHP json_encode(array_filter(arr)):
 * - Nếu array sau filter vẫn liên tục (0,1,2,...) → encode thành JSON array []
 * - Nếu sparse (index bị nhảy) → encode thành JSON object {}
 */
function phpJsonEncodeArrayFilter(arr) {
  const filtered = phpArrayFilter(arr); // object giữ index gốc
  const keys = Object.keys(filtered);

  // Kiểm tra có phải sequential từ 0 không (giống array PHP liên tục)
  const isSequential = keys.every((k, i) => parseInt(k) === i);

  if (isSequential) {
    // Encode như array
    return JSON.stringify(Object.values(filtered));
  } else {
    // Encode như object (sparse array trong PHP → object trong json_encode)
    return JSON.stringify(filtered);
  }
}

// Lọc bỏ param rỗng ở top-level trước khi đưa vào signature
// Chỉ loại null/undefined/"" ở top-level (array rỗng cũng loại)
function filterParams(params) {
  const result = {};
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      if (value.length > 0) result[key] = value;
    } else if (value !== null && value !== undefined && value !== "") {
      result[key] = value;
    }
  }
  return result;
}

/**
 * PHP ksort(): sort key ascending, so sánh byte-by-byte (strcmp)
 * KHÔNG dùng localeCompare
 */
function ksort(obj) {
  return Object.keys(obj)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .reduce((acc, key) => {
      acc[key] = obj[key];
      return acc;
    }, {});
}

function buildSignature(params, clientSecret) {
  // Bước 1: sort theo key — ksort() giống PHP
  const sorted = ksort(params);

  // Bước 2: hash_string = sha1(client_secret)
  const secretHash = sha1(clientSecret);
  let hashString = secretHash;

  console.log("\n========== SIGNATURE BUILD ==========");
  const maskedSecret = clientSecret.slice(0, 4) + "*".repeat(Math.max(0, clientSecret.length - 4));
  console.log(`[1] sha1(client_secret)`);
  console.log(`    client_secret = "${maskedSecret}"`);
  console.log(`    sha1          = "${secretHash}"`);
  console.log(`\n[2] Duyệt từng value sau ksort:`);

  let step = 1;
  for (const [key, value] of Object.entries(sorted)) {
    let v = value;
    let note = "";

    // if value is array: value = json_encode(array_filter(value))
    if (Array.isArray(v)) {
      const encoded = phpJsonEncodeArrayFilter(v);
      note = `array → json_encode(array_filter(...)) = ${encoded}`;
      v = encoded;
    }

    // if value is not empty: hash_string += "|" + html_entity_decode(value)
    const isEmpty = v === null || v === undefined || v === "" || v === false || v === 0 || v === "0";
    if (!isEmpty) {
      const decoded = htmlEntityDecode(String(v));
      hashString += "|" + decoded;
      console.log(`    [${step++}] key="${key}" | raw=${JSON.stringify(value)}${note ? " | " + note : ""}`);
      console.log(`         append → "|${decoded}"`);
    } else {
      console.log(`    [${step++}] key="${key}" | raw=${JSON.stringify(value)} | SKIPPED (empty/falsy)`);
    }
  }

  console.log(`\n[3] Chuỗi cuối trước khi sha1:`);
  console.log(`    "${hashString}"`);

  const signature = sha1(hashString);
  console.log(`\n[4] sha1(hash_string) = "${signature}"`);
  console.log("=====================================\n");

  return signature;
}

// Build query string — array dùng format key[]=val1&key[]=val2
function buildQueryString(params) {
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        parts.push(`${encodeURIComponent(key)}[]=${encodeURIComponent(item)}`);
      }
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.join("&");
}

// ---------- Main ----------

async function callApi() {
  const timestamp = Date.now(); // milliseconds

  // Lấy query params sạch (bỏ rỗng top-level)
  const cleanQueryParams = filterParams(CONFIG.QUERY_PARAMS);

  // Gộp client_id + timestamp + query params để tạo signature
  const signatureParams = {
    client_id: CONFIG.CLIENT_ID,
    timestamp: String(timestamp),
    ...cleanQueryParams,
  };

  const signature = buildSignature(signatureParams, CONFIG.CLIENT_SECRET);

  // URL chỉ chứa query params nghiệp vụ
  const qs = buildQueryString(cleanQueryParams);
  const url = `${BASE_URL}${CONFIG.ENDPOINT}${qs ? "?" + qs : ""}`;

  // Headers chứa client-id, timestamp, signature
  const headers = {
    "Content-Type": "application/json",
    "client-id": CONFIG.CLIENT_ID,
    "timestamp": String(timestamp),
    "signature": signature,
  };

  // ---------- Log request ----------
  console.log("\n========== REQUEST ==========");
  console.log("URL     :", url);
  console.log("Method  :", CONFIG.METHOD);
  console.log("Headers :", headers);
  console.log("Params used for signature (after ksort):", JSON.stringify(ksort(signatureParams), null, 2));
  console.log("==============================\n");

  // ---------- Call API ----------
  try {
    const res = await fetch(url, {
      method: CONFIG.METHOD,
      headers,
    });
    const text = await res.text();

    console.log("========== RESPONSE ==========");
    console.log("Status :", res.status, res.statusText);
    try {
      console.log("Body   :", JSON.stringify(JSON.parse(text), null, 2));
    } catch {
      console.log("Body   :", text);
    }
    console.log("===============================\n");
  } catch (err) {
    console.error("Request failed:", err.message);
  }
}

callApi();
