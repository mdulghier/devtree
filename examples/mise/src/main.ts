const session = document.querySelector<HTMLParagraphElement>("#session")!;
const url = document.querySelector<HTMLAnchorElement>("#url")!;
session.textContent = `Session: ${import.meta.env.VITE_SESSION ?? "Start through Devtree"}`;
url.href = import.meta.env.VITE_APP_URL ?? "/";
url.textContent = import.meta.env.VITE_APP_URL ?? "No session environment loaded";
