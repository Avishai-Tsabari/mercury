import type { MercuryExtensionAPI } from "../../../src/extensions/types.js";

export default function (mercury: MercuryExtensionAPI) {
  // pinchtab CLI is already declared by the pinchtab extension — do NOT re-declare here.
  mercury.permission({ defaultRoles: ["admin", "member"] });
  mercury.skill("./skill");

  // The pinchtab extension injects "always use Brave Search, never use Google" into the
  // system prompt. Structured real-world searches (flights, hotels, etc.) legitimately
  // need Google Travel products and other specialist sites. Append an explicit exception
  // so the agent follows the web-search skill rather than defaulting to Brave.
  mercury.on("before_container", async () => {
    return {
      systemPrompt:
        "Exception to the Brave Search rule: for structured real-world searches " +
        "(flights, hotels, car rentals, cars for purchase, apartments/rentals), " +
        "follow the web-search skill — use the specific sites it specifies " +
        "(e.g. Google Flights, Google Hotels, AutoScout24, Airbnb). " +
        "Do NOT route these requests to Brave Search.",
    };
  });
}
