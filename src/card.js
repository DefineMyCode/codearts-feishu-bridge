export function buildCardMarkdown(markdown, { wide = true } = {}) {
  return JSON.stringify({
    config: {
      wide_screen_mode: wide,
      update_multi: true,
    },
    elements: [
      {
        tag: "markdown",
        content: String(markdown ?? ""),
      },
    ],
  });
}