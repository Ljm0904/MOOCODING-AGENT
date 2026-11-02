import type { Tool } from '../types.ts';

export const todoTool: Tool = {
  spec: {
    name: 'todo_write',
    description:
      'Maintain a task checklist for multi-step work. Send the FULL list each time. Keep exactly one item in_progress; mark items completed as soon as they are done.',
    input_schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
  readOnly: true,
  describe: (i) => `${(i.todos ?? []).length} items`,
  async run(i, ctx) {
    ctx.setTodos(i.todos ?? []);
    return 'Todos updated.';
  },
};

export const submitPlanTool: Tool = {
  spec: {
    name: 'submit_plan',
    description:
      'Plan mode only. Submit your implementation plan for user approval once you have explored the code. Ends your turn. Include the shell commands that would prove the change works (tests, type-check, lint, build).',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One or two sentences on the approach' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: { title: { type: 'string' }, detail: { type: 'string' } },
            required: ['title'],
          },
        },
        verify_commands: {
          type: 'array',
          items: { type: 'string' },
          description: 'Commands that must pass after implementation, e.g. "npm test"',
        },
      },
      required: ['summary', 'steps'],
    },
  },
  readOnly: true,
  describe: (i) => String(i.summary ?? '').slice(0, 80),
  async run(i, ctx) {
    ctx.setPlan({ summary: i.summary, steps: i.steps ?? [], verify_commands: i.verify_commands });
    ctx.requestStop();
    return 'Plan submitted. Waiting for user approval; do nothing further.';
  },
};
