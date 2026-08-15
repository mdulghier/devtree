import "./styles.css";

const app_element = document.querySelector<HTMLElement>("#app");

if (!app_element) {
  throw new Error("Could not find the application element.");
}

const configured_url = import.meta.env.VITE_DEVTREE_PUBLIC_URL || window.location.href;
const session_name = import.meta.env.VITE_DEVTREE_SESSION || "default";

app_element.innerHTML = `
  <section class="card">
    <div class="eyebrow"><span></span> Devtree + Portless</div>
    <h1>This checkout has its own local address.</h1>
    <p class="intro">
      Start another worktree and both applications can run side by side without
      choosing ports or editing environment files.
    </p>

    <dl>
      <div>
        <dt>Session</dt>
        <dd>${session_name}</dd>
      </div>
      <div>
        <dt>Configured URL</dt>
        <dd><a href="${configured_url}">${configured_url}</a></dd>
      </div>
      <div>
        <dt>Browser URL</dt>
        <dd>${window.location.href}</dd>
      </div>
    </dl>

    <p class="footnote">Edit <code>src/main.ts</code> to test Vite's live updates.</p>
  </section>
`;
