try {
  const theme = JSON.parse(localStorage.getItem("sati.ui.v1") || "{}").theme;
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {
  // No storage or rubbish in it: follow the device.
}
