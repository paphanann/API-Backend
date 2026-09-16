function renderAuthorizePage({ platform, confirmUrl, cancelUrl }) {
  return `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>อนุญาต ${platform}</title>
  <style>
    body { font-family: "Segoe UI", Tahoma, sans-serif; background: #f4f6f8; margin: 0; }
    .card { max-width: 420px; margin: 72px auto; background: #fff; border-radius: 12px; padding: 28px; box-shadow: 0 8px 24px rgba(0,0,0,.08); }
    h1 { font-size: 20px; margin: 0 0 8px; }
    p { color: #556070; line-height: 1.5; }
    .note { background: #fff7e6; color: #8a6d1b; padding: 10px 12px; border-radius: 8px; font-size: 13px; }
    .actions { display: flex; gap: 10px; margin-top: 20px; }
    a, button { flex: 1; text-align: center; text-decoration: none; border: 0; border-radius: 8px; padding: 12px 14px; font-size: 14px; cursor: pointer; }
    .ok { background: #ee4d2d; color: #fff; }
    .cancel { background: #eef1f4; color: #334; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${platform} ขออนุญาตเข้าถึงร้านค้า</h1>
    <p>PASS ต้องการเชื่อมต่อร้านค้าเพื่อดึงคำสั่งซื้อและซิงค์ข้อมูล</p>
    <div class="note">โหมดทดสอบของ Backend — ยังไม่มี Partner Key จริง เมื่อใส่ใน .env แล้วจะพาไปหน้า ${platform} จริง</div>
    <div class="actions">
      <a class="cancel" href="${cancelUrl}">ยกเลิก</a>
      <a class="ok" href="${confirmUrl}">Authorize</a>
    </div>
  </div>
</body>
</html>`;
}

module.exports = {
  renderAuthorizePage,
};
