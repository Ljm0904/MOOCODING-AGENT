import type { Tool } from '../types.ts';
import { editFileTool, readFileTool, writeFileTool } from './fs.ts';
import { todoTool } from './meta.ts';
import { globTool, grepTool } from './search.ts';
import { bashTool } from './shell.ts';

/** Tools every agent (including sub-agents) gets. */
export const baseTools = (): Tool[] => [readFileTool, globTool, grepTool, editFileTool, writeFileTool, bashTool, todoTool];
export const readOnlyTools = (): Tool[] => baseTools().filter((t) => t.readOnly && t.spec.name !== 'todo_write');
