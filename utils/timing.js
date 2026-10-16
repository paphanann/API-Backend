function startTimer(label) {
  const started = Date.now();
  return (detail) => {
    const ms = Date.now() - started;
    const extra = detail ? ` ${detail}` : "";
    console.log(`[timing] ${label} ${ms}ms${extra}`);
    return ms;
  };
}

module.exports = {
  startTimer,
};
