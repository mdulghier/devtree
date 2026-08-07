import "./styles.css";

const app_element = document.querySelector<HTMLElement>("#app");

if (!app_element) {
  throw new Error("Could not find the application element.");
}

const configured_url = import.meta.env.VITE_DEVTREE_PUBLIC_URL || window.location.href;
const public_hostname = import.meta.env.VITE_DEVTREE_PUBLIC_HOSTNAME || window.location.hostname;
const worktree_name = import.meta.env.VITE_DEVTREE_WORKTREE || "main checkout";
const database_port = import.meta.env.VITE_DATABASE_PORT || "not configured";
const redis_port = import.meta.env.VITE_REDIS_PORT || "not configured";

app_element.innerHTML = `
  <section class="card">
    <div class="eyebrow"><span></span> Devtree + Caddy + Tailscale</div>
    <h1>One address, from either machine.</h1>
    <p class="intro">
      Caddy sends this hostname to the correct local Vite process. A hosts file
      makes the same name available on this machine and other machines on your Tailscale network.
    </p>

    <div class="hostname">${public_hostname}</div>

    <dl>
      <div>
        <dt>Checkout</dt>
        <dd>${worktree_name}</dd>
      </div>
      <div>
        <dt>Configured URL</dt>
        <dd><a href="${configured_url}">${configured_url}</a></dd>
      </div>
      <div>
        <dt>Browser URL</dt>
        <dd>${window.location.href}</dd>
      </div>
      <div>
        <dt>PostgreSQL</dt>
        <dd>127.0.0.1:${database_port}</dd>
      </div>
      <div>
        <dt>Redis</dt>
        <dd>127.0.0.1:${redis_port}</dd>
      </div>
    </dl>

    <p class="footnote">Run <code>pnpm devtree hosts</code> for the exact hosts file lines.</p>
  </section>
`;
