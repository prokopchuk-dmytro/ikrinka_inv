import type { ActionFunctionArgs } from "@remix-run/node";

export async function action({ request }: ActionFunctionArgs) {
	try {
		const contentType = request.headers.get("content-type") || "";
		if (!contentType.includes("application/json")) {
			console.error("/api/log: invalid content-type", contentType);
			return new Response(null, { status: 415 });
		}

		const body = await request.json().catch(() => null);
		if (!body) {
			console.error("/api/log: empty or invalid JSON");
			return new Response(null, { status: 400 });
		}

		console.error("[UI EXT ERROR]", JSON.stringify(body));
		return new Response(null, { status: 204 });
	} catch (error) {
		console.error("/api/log: exception", error);
		return new Response(null, { status: 500 });
	}
}