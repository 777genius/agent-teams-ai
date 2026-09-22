const taskStore = require('./taskStore.js');
const runtimeHelpers = require('./runtimeHelpers.js');

function normalizeActorName(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function isClearOwnerValue(value) {
    return value == null || value === 'clear' || value === 'none';
}

function assertKnownTaskActor(context, value, label) {
    return runtimeHelpers.assertExplicitTeamMemberName(context.paths, value, label, {
        allowLeadAliases: true,
    });
}

function resolveAgentTaskMutationActor(context, actor, action) {
    const normalizedActor = normalizeActorName(actor);
    if (context.allowUserMessageSender !== false) {
        return normalizedActor || undefined;
    }
    if (!normalizedActor) {
        throw new Error(`${action} requires actor to be your configured teammate name.`);
    }
    return assertKnownTaskActor(context, normalizedActor, 'task actor');
}

function isLeadTaskActor(context, actor) {
    const leadName = runtimeHelpers.inferLeadName(context.paths);
    return isSameTaskMember(actor, leadName, leadName);
}

function assertTaskOwnerMutation(context, task, actor, action, options = {}) {
    const resolvedActor = resolveAgentTaskMutationActor(context, actor, action);
    if (context.allowUserMessageSender !== false) {
        return resolvedActor;
    }

    const owner = normalizeActorName(task && task.owner);
    const leadName = runtimeHelpers.inferLeadName(context.paths);
    if (owner && isSameTaskMember(owner, resolvedActor, leadName)) {
        return resolvedActor;
    }
    if (options.allowLeadOverride === true && isLeadTaskActor(context, resolvedActor)) {
        return resolvedActor;
    }

    const taskLabel = `#${task.displayId || task.id}`;
    if (!owner) {
        throw new Error(
            `Task ${taskLabel} is unassigned; ${resolvedActor} cannot ${action}. ` +
                'Claim it with task_set_owner before changing its lifecycle.'
        );
    }
    throw new Error(
        `Task ${taskLabel} is owned by ${owner}; ${resolvedActor} cannot ${action}. ` +
            'Refresh with task_get and ask the current owner or lead to reassign it first.'
    );
}

function assertTaskOwnerChange(context, task, nextOwner, actor) {
    const resolvedActor = resolveAgentTaskMutationActor(context, actor, 'task_set_owner');
    if (context.allowUserMessageSender !== false) {
        return resolvedActor;
    }

    const currentOwner = normalizeActorName(task && task.owner);
    const normalizedNextOwner = normalizeActorName(nextOwner);
    const leadName = runtimeHelpers.inferLeadName(context.paths);
    if (isLeadTaskActor(context, resolvedActor)) {
        return resolvedActor;
    }
    if (currentOwner && isSameTaskMember(currentOwner, resolvedActor, leadName)) {
        return resolvedActor;
    }
    if (
        !currentOwner &&
        (!normalizedNextOwner || isSameTaskMember(normalizedNextOwner, resolvedActor, leadName))
    ) {
        return resolvedActor;
    }

    const taskLabel = `#${task.displayId || task.id}`;
    if (!currentOwner) {
        throw new Error(
            `Task ${taskLabel} is unassigned; ${resolvedActor} may only assign it to themselves. ` +
                'Ask the lead to assign another owner.'
        );
    }
    throw new Error(
        `Task ${taskLabel} is owned by ${currentOwner}; ${resolvedActor} cannot reassign it. ` +
            'Ask the current owner or lead to hand it off.'
    );
}

function assertTaskNotDeleted(task, action) {
    if (task && task.status === 'deleted') {
        throw new Error(`Task #${task.displayId || task.id} is deleted; use task_restore before ${action}`);
    }
}

function readMutableTask(context, taskId, action) {
    const task = taskStore.readTask(context.paths, taskId, { includeDeleted: true });
    assertTaskNotDeleted(task, action);
    return task;
}

function isSameMember(left, right) {
    return normalizeActorName(left).toLowerCase() === normalizeActorName(right).toLowerCase();
}

function isSameTaskMember(left, right, leadName) {
    const normalizedLeft = normalizeActorName(left).toLowerCase();
    const normalizedRight = normalizeActorName(right).toLowerCase();
    const normalizedLead = normalizeActorName(leadName).toLowerCase();
    if (!normalizedLeft || !normalizedRight) {
        return false;
    }
    if (normalizedLeft === normalizedRight) {
        return true;
    }
    return (
        (normalizedLeft === 'team-lead' && normalizedRight === normalizedLead) ||
        (normalizedRight === 'team-lead' && normalizedLeft === normalizedLead)
    );
}

module.exports = {
    assertKnownTaskActor,
    assertTaskNotDeleted,
    assertTaskOwnerChange,
    assertTaskOwnerMutation,
    isClearOwnerValue,
    isSameMember,
    isSameTaskMember,
    normalizeActorName,
    readMutableTask,
};
