import config from "@/config";

export const getCommentHeader = () => {
  // A self-hosted install doesn't send its users to Argos's site.
  if (config.get("selfHosted")) {
    return "**The latest updates on your projects.**";
  }
  return "**The latest updates on your projects.** Learn more about [Argos notifications ↗︎](https://argos-ci.com/docs/learn/review-workflow/pull-request-comments)";
};

export const getPendingCommentBody = () => {
  return [
    getCommentHeader(),
    "",
    "Awaiting the start of a new Argos build…",
  ].join("\n");
};
