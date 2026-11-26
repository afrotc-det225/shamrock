// Only this browser origin can enter the explicitly bound staging panel.
export default {
  fetch(request, env) {
    if (new URL(request.url).origin !== "https://shamrock.det225.workers.dev")
      return new Response("Unknown SHAMROCK address.", {status: 403});
    return env.STAGING_PANEL.fetch(request);
  },
};
