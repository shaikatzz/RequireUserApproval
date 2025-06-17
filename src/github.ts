import * as core from "@actions/core";
import * as github from "@actions/github";
import { PullsListReviewsResponseData } from "@octokit/types/dist-types/generated/Endpoints.d";
import { Context } from "@actions/github/lib/context";
import { GitHub } from "@actions/github/lib/utils";
import partition from "lodash/partition";
import yaml from "yaml";
import { Config, ConfigGroup } from "./config";

const teams: { [team: string]: string[] } = {};

async function getTeamMembers(teamName: string): Promise<string[]> {
  const context = get_context();
  const octokit = get_octokit();

  const members = await octokit.teams.listMembersInOrg({
    org: context.repo.owner,
    team_slug: teamName,
  });

  let teamMembers: string[] = [];

  for (let i = 0; i < members.data.length; i++) {
    let member = members.data[i];
    teamMembers.push(member.login);
  }

  teams[teamName] = teamMembers;

  return teamMembers;
}

async function assign_reviewers(group: ConfigGroup) {
  const context = get_context();
  const octokit = get_octokit();

  if (context.payload.pull_request == undefined) {
    throw "Pull Request Number is Null";
  }

  const [teams_with_prefix, individuals] = partition(group.members, (member) =>
    member.startsWith("team:")
  );
  const teams = teams_with_prefix.map((team_with_prefix) =>
    team_with_prefix.replace("team:", "")
  );

  // Get PR author more reliably by querying the API
  const prData = await octokit.pulls.get({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.payload.pull_request.number,
  });

  const prAuthor = prData.data.user.login;
  const payloadAuthor = context.payload.pull_request.user?.login;

  // Debug logging
  core.info(`PR Author from API: ${prAuthor}`);
  core.info(`PR Author from payload: ${payloadAuthor}`);
  core.info(`Original individuals: ${JSON.stringify(individuals)}`);

  // Filter out the PR author from individual reviewers to avoid GitHub API errors
  const filteredIndividuals = individuals.filter(
    (reviewer) => reviewer !== prAuthor
  );

  core.info(`Filtered individuals: ${JSON.stringify(filteredIndividuals)}`);

  return octokit.pulls.requestReviewers({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.payload.pull_request.number,
    reviewers: filteredIndividuals,
    team_reviewers: teams,
  });
}

async function remove_reviewers(group: ConfigGroup) {
  const context = get_context();
  const octokit = get_octokit();

  if (context.payload.pull_request == undefined) {
    throw "Pull Request Number is Null";
  }

  const [teams_with_prefix] = partition(group.members, (member) =>
    member.startsWith("team:")
  );
  const teams = teams_with_prefix.map((team_with_prefix) =>
    team_with_prefix.replace("team:", "")
  );

  if (teams.length === 0) {
    return;
  }

  return octokit.pulls.removeRequestedReviewers({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.payload.pull_request.number,
    reviewers: [],
    team_reviewers: teams,
  });
}

async function fetch_config(): Promise<Config> {
  const context = get_context();
  const octokit = get_octokit();
  const config_path = get_config_path();

  const { data: response_body } = await octokit.repos.getContent({
    owner: context.repo.owner,
    repo: context.repo.repo,
    path: config_path,
    ref: context.ref,
  });

  var ymlContent = Buffer.from(response_body.content, "base64").toString();

  return yaml.parse(ymlContent);
}

async function fetch_changed_files(): Promise<string[]> {
  const context = get_context();

  if (!context.payload.pull_request) {
    throw "No pull request found.";
  }
  const octokit = get_octokit();

  const changed_files: string[] = [];

  const per_page = 100;

  let page = 0;

  let number_of_files_in_current_page: number;

  do {
    page += 1;

    const { data: response_body } = await octokit.pulls.listFiles({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: context.payload.pull_request.number,
      page,
      per_page,
    });

    number_of_files_in_current_page = response_body.length;

    changed_files.push(...response_body.map((file) => file.filename));
  } while (number_of_files_in_current_page === per_page);

  return changed_files;
}

async function get_reviews(): Promise<PullsListReviewsResponseData> {
  const octokit = get_octokit();

  const context = get_context();

  if (!context.payload.pull_request) {
    throw "No pull request found.";
  }

  const result: PullsListReviewsResponseData = [];

  const per_page = 100;

  let page = 0;

  let number_of_files_in_current_page: number;

  do {
    page += 1;

    const reviewsResult = await octokit.pulls.listReviews({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: context.payload.pull_request.number,
      page: page,
      per_page: per_page,
    });

    number_of_files_in_current_page = reviewsResult.data.length;

    result.push(...reviewsResult.data);
  } while (number_of_files_in_current_page === per_page);

  return result;
}

async function get_requested_reviewers(): Promise<{
  users: string[];
  teams: string[];
}> {
  const octokit = get_octokit();
  const context = get_context();

  if (!context.payload.pull_request) {
    throw "No pull request found.";
  }

  const { data: response } = await octokit.pulls.listRequestedReviewers({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.payload.pull_request.number,
  });

  const users = response.users.map((user) => user.login);
  const teams = response.teams.map((team) => team.slug);

  return { users, teams };
}

async function find_existing_comment(): Promise<number | null> {
  const context = get_context();
  const octokit = get_octokit();

  if (context.payload.pull_request == undefined) {
    throw "Pull Request Number is Null";
  }

  const comments = await octokit.issues.listComments({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: context.payload.pull_request.number,
  });

  // Look for our comment by checking for our unique identifier
  const existingComment = comments.data.find((comment) =>
    comment.body?.includes(
      "*This comment is automatically updated by the RequireUserApproval action.*"
    )
  );

  return existingComment ? existingComment.id : null;
}

async function post_pr_comment(message: string) {
  const context = get_context();
  const octokit = get_octokit();

  if (context.payload.pull_request == undefined) {
    throw "Pull Request Number is Null";
  }

  // Always delete any existing comment first so the new one appears at the bottom
  const existingCommentId = await find_existing_comment();
  if (existingCommentId) {
    await octokit.issues.deleteComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: existingCommentId,
    });
  }

  // Create a new comment (will appear at the bottom)
  return octokit.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: context.payload.pull_request.number,
    body: message,
  });
}

async function delete_pr_comment() {
  const context = get_context();
  const octokit = get_octokit();

  if (context.payload.pull_request == undefined) {
    throw "Pull Request Number is Null";
  }

  // Check if there's an existing comment from this action
  const existingCommentId = await find_existing_comment();

  if (existingCommentId) {
    // Delete the existing comment
    return octokit.issues.deleteComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: existingCommentId,
    });
  }

  // No comment to delete
  return null;
}

async function create_status_check(
  state: "success" | "failure" | "pending",
  description: string
) {
  const context = get_context();
  const octokit = get_octokit();

  if (context.payload.pull_request == undefined) {
    throw "Pull Request Number is Null";
  }

  const sha = context.payload.pull_request.head.sha;

  return octokit.repos.createCommitStatus({
    owner: context.repo.owner,
    repo: context.repo.repo,
    sha: sha,
    state: state,
    context: "bcp-approval",
    description: description,
  });
}

let cacheContext: Context | null = null;

let cacheToken: string | null = null;

let cacheConfigPath: string | null = null;

let cacheOctoKit: InstanceType<typeof GitHub> | null = null;

let get_context: () => Context = () =>
  cacheContext || (cacheContext = github.context);

let get_token: () => string = () =>
  cacheToken || (cacheToken = core.getInput("token"));

let get_config_path: () => string = () =>
  cacheConfigPath || (cacheConfigPath = core.getInput("config"));

let get_octokit: () => InstanceType<typeof GitHub> = () =>
  cacheOctoKit || (cacheOctoKit = github.getOctokit(get_token()));

export default {
  fetch_config,
  get_reviews,
  fetch_changed_files,
  assign_reviewers,
  remove_reviewers,
  getTeamMembers,
  post_pr_comment,
  get_requested_reviewers,
  find_existing_comment,
  delete_pr_comment,
  create_status_check,
};
