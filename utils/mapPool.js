async function mapPool(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length);
  if (!list.length) return out;

  let next = 0;
  const workers = Math.min(Math.max(Number(limit) || 1, 1), list.length);

  async function run() {
    while (next < list.length) {
      const index = next;
      next += 1;
      out[index] = await fn(list[index], index);
    }
  }

  await Promise.all(Array.from({ length: workers }, () => run()));
  return out;
}

module.exports = {
  mapPool,
};
