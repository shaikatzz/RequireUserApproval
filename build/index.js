"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const minimatch = __importStar(require("minimatch"));
const github_1 = __importDefault(require("./github"));
function run() {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        core.info("Fetching configuration...");
        let config;
        try {
            config = yield github_1.default.fetch_config();
        }
        catch (error) {
            if (error.status === 404) {
                core.warning("No configuration file is found in the base branch; terminating the process");
            }
            throw error;
        }
        core.info("Config: ");
        core.info(JSON.stringify(config, null, "\t"));
        core.info("Getting reviews...");
        let reviews = yield github_1.default.get_reviews();
        core.info("Getting requested reviewers...");
        let requestedReviewers = yield github_1.default.get_requested_reviewers();
        core.info(`Requested reviewer users: ${JSON.stringify(requestedReviewers.users)}`);
        core.info(`Requested reviewer teams: ${JSON.stringify(requestedReviewers.teams)}`);
        let requirementCounts = {};
        let requirementMembers = {};
        core.info("Retrieving required group configurations...");
        let { affected: affectedGroups, unaffected: unaffectedGroups } = identifyGroupsByChangedFiles(config, yield github_1.default.fetch_changed_files());
        for (let groupName in affectedGroups) {
            core.info(` - Group: ${groupName}`);
            if (affectedGroups[groupName].required == undefined) {
                core.warning(" - Group Required Count not specified, assuming 1 approver from group required.");
                affectedGroups[groupName].required = 1;
            }
            else {
                requirementCounts[groupName] = (_a = affectedGroups[groupName].required) !== null && _a !== void 0 ? _a : 1;
            }
            requirementMembers[groupName] = {};
            core.info(` - Requiring ${affectedGroups[groupName].required} of the following:`);
            for (let i in affectedGroups[groupName].members) {
                let member = affectedGroups[groupName].members[i];
                if (member.startsWith("team:")) {
                    // extract teams.
                    let teamMembers = yield github_1.default.getTeamMembers(member.substring(5));
                    for (let j in teamMembers) {
                        let teamMember = teamMembers[j];
                        requirementMembers[groupName][teamMember] = false;
                        core.info(`   - ${teamMember}`);
                    }
                }
                else {
                    requirementMembers[groupName][member] = false;
                    core.info(`   - ${member}`);
                }
            }
        }
        let reviewerState = {};
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
                    core.info(`${userName} has an APPROVED review but is still in requested reviewers (review was likely dismissed), not counting as approved`);
                    continue;
                }
                for (let group in requirementMembers) {
                    for (let member in requirementMembers[group]) {
                        if (member == userName) {
                            requirementMembers[group][member] = true;
                            core.info(`${userName} is a member of ${group} and has been approved`);
                        }
                    }
                }
            }
        }
        let failed = false;
        let failedGroups = [];
        core.info("Checking for required reviewers...");
        for (let groupName in requirementMembers) {
            let groupApprovalRequired = requirementCounts[groupName];
            let groupMemberApprovals = requirementMembers[groupName];
            let groupApprovalCount = 0;
            let groupNotApprovedStrings = [];
            let groupApprovedStrings = [];
            core.info(`Checking group ${groupName}...`);
            for (let member in groupMemberApprovals) {
                if (groupMemberApprovals[member]) {
                    groupApprovalCount++;
                    groupApprovedStrings.push(member);
                }
                else {
                    groupNotApprovedStrings.push(member);
                }
            }
            if (groupApprovalCount >= groupApprovalRequired) {
                //Enough Approvers
                core.startGroup(`✅ ${groupName}: (${groupApprovalCount}/${groupApprovalRequired}) approval(s).`);
                let appCount = 0;
                for (let approval in groupApprovedStrings) {
                    core.info(`(${++appCount}/${groupApprovalRequired}) ✅ ${groupApprovedStrings[approval]}`);
                }
                for (let unapproval in groupNotApprovedStrings) {
                    core.info(`(${appCount}/${groupApprovalRequired})    ${groupNotApprovedStrings[unapproval]}`);
                }
                core.endGroup();
                yield github_1.default.remove_reviewers(affectedGroups[groupName]);
            }
            else {
                failed = true;
                failedGroups.push(groupName);
                yield github_1.default.assign_reviewers(affectedGroups[groupName]);
                core.startGroup(`❌ ${groupName}: (${groupApprovalCount}/${groupApprovalRequired}) approval(s).`);
                let appCount = 0;
                for (let approval in groupApprovedStrings) {
                    core.info(`(${++appCount}/${groupApprovalRequired}) ✅ ${groupApprovedStrings[approval]}`);
                }
                for (let unapproval in groupNotApprovedStrings) {
                    core.info(`(${appCount}/${groupApprovalRequired}) ❌ ${groupNotApprovedStrings[unapproval]}`);
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
                let approvedMembers = [];
                let pendingMembers = [];
                for (let member in groupMemberApprovals) {
                    if (groupMemberApprovals[member]) {
                        groupApprovalCount++;
                        approvedMembers.push(member);
                    }
                    else {
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
            yield github_1.default.post_pr_comment(commentBody);
            core.setFailed(`Need approval from these groups: ${failedGroups.join(", ")}`);
        }
        else {
            // All approvals are satisfied, delete any existing comment
            core.info("All approval requirements satisfied, removing approval comment if it exists");
            yield github_1.default.delete_pr_comment();
        }
    });
}
function identifyGroupsByChangedFiles(config, changedFiles) {
    const affected = {};
    const unaffected = {};
    for (let groupName in config.groups) {
        const group = config.groups[groupName];
        const fileGlobs = group.paths;
        if (fileGlobs == null || fileGlobs == undefined || fileGlobs.length == 0) {
            core.warning(`No specific path globs assigned for group ${groupName}, assuming global approval.`);
            affected[groupName] = group;
        }
        else if (fileGlobs.filter((glob) => minimatch.match(changedFiles, glob, {
            nonull: false,
            matchBase: true,
        }).length > 0).length > 0) {
            affected[groupName] = group;
        }
        else {
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
