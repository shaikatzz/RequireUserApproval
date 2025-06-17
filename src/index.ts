import * as core from "@actions/core";
import * as minimatch from "minimatch";
import { Config, ConfigGroup } from "./config";
import github from "./github";

async function run() {
  core.info("Fetching configuration...");

  let config;

  try {
    config = await github.fetch_config();
  } catch (error: any) {
    if (error.status === 404) {
      core.warning(
        "No configuration file is found in the base branch; terminating the process"
      );
    }
    throw error;
  }

  core.info("Config: ");
  core.info(JSON.stringify(config, null, "\t"));

  core.info("Getting reviews...");
  let reviews = await github.get_reviews();

  core.info("Getting requested reviewers...");
  let requestedReviewers = await github.get_requested_reviewers();
  core.info(
    `Requested reviewer users: ${JSON.stringify(requestedReviewers.users)}`
  );
  core.info(
    `Requested reviewer teams: ${JSON.stringify(requestedReviewers.teams)}`
  );

  let requirementCounts: { [group: string]: number } = {};
  let requirementMembers: { [group: string]: { [user: string]: boolean } } = {};
  core.info("Retrieving required group configurations...");

  let { affected: affectedGroups, unaffected: unaffectedGroups } =
    identifyGroupsByChangedFiles(config, await github.fetch_changed_files());

  for (let groupName in affectedGroups) {
    core.info(` - Group: ${groupName}`);
    if (affectedGroups[groupName].required == undefined) {
      core.warning(
        " - Group Required Count not specified, assuming 1 approver from group required."
      );
      affectedGroups[groupName].required = 1;
    } else {
      requirementCounts[groupName] = affectedGroups[groupName].required ?? 1;
    }
    requirementMembers[groupName] = {};
    core.info(
      ` - Requiring ${affectedGroups[groupName].required} of the following:`
    );
    for (let i in affectedGroups[groupName].members) {
      let member = affectedGroups[groupName].members[i];

      if (member.startsWith("team:")) {
        // extract teams.

        let teamMembers = await github.getTeamMembers(member.substring(5));

        for (let j in teamMembers) {
          let teamMember = teamMembers[j];

          requirementMembers[groupName][teamMember] = false;

          core.info(`   - ${teamMember}`);
        }
      } else {
        requirementMembers[groupName][member] = false;

        core.info(`   - ${member}`);
      }
    }
  }

  let reviewerState: { [group: string]: string } = {};

  core.info("Getting most recent review for each reviewer...");
  for (let i = 0; i < reviews.length; i++) {
    let review = reviews[i];
    let userName = review.user.login;
    let state = review.state;
    reviewerState[userName] = state;
    core.info(`Found ${userName} with state ${state}`);
  }

  core.info("Processing reviews...");

  for (let userName in reviewerState) {
    let state = reviewerState[userName];
    if (state == "APPROVED") {
      // Check if this user is still in the requested reviewers list
      // If they are, it means their review was dismissed and they need to re-approve
      if (requestedReviewers.users.includes(userName)) {
        core.info(
          `${userName} has an APPROVED review but is still in requested reviewers (review was likely dismissed), not counting as approved`
        );
        continue;
      }

      for (let group in requirementMembers) {
        for (let member in requirementMembers[group]) {
          if (member == userName) {
            requirementMembers[group][member] = true;
            core.info(
              `${userName} is a member of ${group} and has been approved`
            );
          }
        }
      }
    }
  }

  let failed = false;

  let failedGroups: string[] = [];

  core.info("Checking for required reviewers...");

  for (let groupName in requirementMembers) {
    let groupApprovalRequired = requirementCounts[groupName];
    let groupMemberApprovals = requirementMembers[groupName];
    let groupApprovalCount = 0;
    let groupNotApprovedStrings: string[] = [];
    let groupApprovedStrings: string[] = [];

    core.info(`Checking group ${groupName}...`);

    for (let member in groupMemberApprovals) {
      if (groupMemberApprovals[member]) {
        groupApprovalCount++;
        groupApprovedStrings.push(member);
      } else {
        groupNotApprovedStrings.push(member);
      }
    }

    if (groupApprovalCount >= groupApprovalRequired) {
      //Enough Approvers
      core.startGroup(
        `✅ ${groupName}: (${groupApprovalCount}/${groupApprovalRequired}) approval(s).`
      );
      let appCount = 0;
      for (let approval in groupApprovedStrings) {
        core.info(
          `(${++appCount}/${groupApprovalRequired}) ✅ ${
            groupApprovedStrings[approval]
          }`
        );
      }
      for (let unapproval in groupNotApprovedStrings) {
        core.info(
          `(${appCount}/${groupApprovalRequired})    ${groupNotApprovedStrings[unapproval]}`
        );
      }
      core.endGroup();

      await github.remove_reviewers(affectedGroups[groupName]);
    } else {
      failed = true;
      failedGroups.push(groupName);
      await github.assign_reviewers(affectedGroups[groupName]);
      core.startGroup(
        `❌ ${groupName}: (${groupApprovalCount}/${groupApprovalRequired}) approval(s).`
      );
      let appCount = 0;
      for (let approval in groupApprovedStrings) {
        core.info(
          `(${++appCount}/${groupApprovalRequired}) ✅ ${
            groupApprovedStrings[approval]
          }`
        );
      }
      for (let unapproval in groupNotApprovedStrings) {
        core.info(
          `(${appCount}/${groupApprovalRequired}) ❌ ${groupNotApprovedStrings[unapproval]}`
        );
      }
      core.endGroup();
    }
  }
  if (failed) {
    // Generate comment about missing approvals
    let commentBody = "## 🔍 Required Approvals Missing\n\n";
    commentBody += "This PR requires approval from the following groups:\n\n";

    for (let groupName of failedGroups) {
      let groupApprovalRequired = requirementCounts[groupName];
      let groupMemberApprovals = requirementMembers[groupName];
      let groupApprovalCount = 0;
      let approvedMembers: string[] = [];
      let pendingMembers: string[] = [];

      for (let member in groupMemberApprovals) {
        if (groupMemberApprovals[member]) {
          groupApprovalCount++;
          approvedMembers.push(member);
        } else {
          pendingMembers.push(member);
        }
      }

      commentBody += `### ${groupName} (${groupApprovalCount}/${groupApprovalRequired} approvals)\n`;

      if (approvedMembers.length > 0) {
        commentBody +=
          "✅ **Approved by:** " +
          approvedMembers.map((m) => `@${m}`).join(", ") +
          "\n";
      }

      commentBody +=
        "⏳ **Still need approval from one of:** " +
        pendingMembers.map((m) => `@${m}`).join(", ") +
        "\n\n";
    }

    commentBody +=
      "\n---\n*This comment is automatically updated by the RequireUserApproval action.*";

    // Post the comment
    await github.post_pr_comment(commentBody);

    core.setFailed(
      `Need approval from these groups: ${failedGroups.join(", ")}`
    );
  } else {
    // All approvals are satisfied, delete any existing comment
    core.info(
      "All approval requirements satisfied, removing approval comment if it exists"
    );
    await github.delete_pr_comment();
  }
}

function identifyGroupsByChangedFiles(
  config: Config,
  changedFiles: string[]
): {
  affected: { [name: string]: ConfigGroup };
  unaffected: { [name: string]: ConfigGroup };
} {
  const affected: { [name: string]: ConfigGroup } = {};
  const unaffected: { [name: string]: ConfigGroup } = {};
  for (let groupName in config.groups) {
    const group = config.groups[groupName];
    const fileGlobs = group.paths;
    if (fileGlobs == null || fileGlobs == undefined || fileGlobs.length == 0) {
      core.warning(
        `No specific path globs assigned for group ${groupName}, assuming global approval.`
      );
      affected[groupName] = group;
    } else if (
      fileGlobs.filter(
        (glob) =>
          minimatch.match(changedFiles, glob, {
            nonull: false,
            matchBase: true,
          }).length > 0
      ).length > 0
    ) {
      affected[groupName] = group;
    } else {
      unaffected[groupName] = group;
    }
  }
  return { affected, unaffected };
}

module.exports = {
  run,
};

// Run the action if it's not running in an automated testing environment
if (process.env.NODE_ENV !== "automated-testing") {
  run().catch((error) => {
    console.log(error);
    core.setFailed(error);
  });
}
