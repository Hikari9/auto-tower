// Cloudflare Workers entry. The D1-backed SqlDatabase is deferred (see DEFERRED.md),
// so until it lands this entry answers every request with 503 and touches no data.
export default {
  fetch(): Response {
    return Response.json(
      {
        error: {
          code: 'not_configured',
          message: 'Storage binding is not configured',
        },
      },
      { status: 503 },
    );
  },
};
