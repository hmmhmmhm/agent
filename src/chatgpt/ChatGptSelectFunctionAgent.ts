import { IHttpLlmFunction, ILlmApplication } from "@samchon/openapi";
import OpenAI from "openai";
import typia, { IValidation } from "typia";
import { v4 } from "uuid";

import { WrtnAgentConstant } from "../internal/WrtnAgentConstant";
import { WrtnAgentDefaultPrompt } from "../internal/WrtnAgentDefaultPrompt";
import { WrtnAgentPromptFactory } from "../internal/WrtnAgentPromptFactory";
import { WrtnAgentSystemPrompt } from "../internal/WrtnAgentSystemPrompt";
import { IWrtnAgentContext } from "../structures/IWrtnAgentContext";
import { IWrtnAgentController } from "../structures/IWrtnAgentController";
import { IWrtnAgentEvent } from "../structures/IWrtnAgentEvent";
import { IWrtnAgentOperation } from "../structures/IWrtnAgentOperation";
import { IWrtnAgentOperationSelection } from "../structures/IWrtnAgentOperationSelection";
import { IWrtnAgentPrompt } from "../structures/IWrtnAgentPrompt";
import { __IChatFunctionReference } from "../structures/internal/__IChatFunctionReference";
import { __IChatSelectFunctionsApplication } from "../structures/internal/__IChatSelectFunctionsApplication";
import { ChatGptHistoryDecoder } from "./ChatGptHistoryDecoder";

export namespace ChatGptSelectFunctionAgent {
  export const execute = async (
    ctx: IWrtnAgentContext,
  ): Promise<IWrtnAgentPrompt[]> => {
    if (ctx.operations.divided === undefined)
      return step(ctx, ctx.operations.array, 0);

    const stacks: IWrtnAgentOperationSelection[][] = ctx.operations.divided.map(
      () => [],
    );
    const events: IWrtnAgentEvent[] = [];
    const prompts: IWrtnAgentPrompt[][] = await Promise.all(
      ctx.operations.divided.map((operations, i) =>
        step(
          {
            ...ctx,
            stack: stacks[i]!,
            dispatch: async (e) => {
              events.push(e);
            },
          },
          operations,
          0,
        ),
      ),
    );

    // NO FUNCTION SELECTION, SO THAT ONLY TEXT LEFT
    if (stacks.every((s) => s.length === 0)) return prompts[0]!;
    // ELITICISM
    else if ((ctx.config?.eliticism ?? WrtnAgentConstant.ELITICISM) === true)
      return step(
        ctx,
        stacks
          .flat()
          .map(
            (s) =>
              ctx.operations.group
                .get(s.controller.name)!
                .get(s.function.name)!,
          ),
        0,
      );

    // RE-COLLECT SELECT FUNCTION EVENTS
    const collection: IWrtnAgentPrompt.ISelect = {
      id: v4(),
      type: "select",
      operations: [],
    };
    for (const e of events)
      if (e.type === "select") {
        collection.operations.push(
          WrtnAgentPromptFactory.selection({
            protocol: e.operation.protocol as "http",
            controller: e.operation.controller as IWrtnAgentController.IHttp,
            function: e.operation.function as IHttpLlmFunction<"chatgpt">,
            reason: e.reason,
            name: e.operation.name,
          }),
        );
        await selectFunction(ctx, {
          name: e.operation.name,
          reason: e.reason,
        });
      }
    return [collection];
  };

  const step = async (
    ctx: IWrtnAgentContext,
    operations: IWrtnAgentOperation[],
    retry: number,
    failures?: IFailure[],
  ): Promise<IWrtnAgentPrompt[]> => {
    //----
    // EXECUTE CHATGPT API
    //----
    const completion: OpenAI.ChatCompletion = await ctx.request("select", {
      messages: [
        // COMMON SYSTEM PROMPT
        {
          role: "system",
          content: WrtnAgentDefaultPrompt.write(ctx.config),
        } satisfies OpenAI.ChatCompletionSystemMessageParam,
        // CANDIDATE FUNCTIONS
        {
          role: "assistant",
          tool_calls: [
            {
              type: "function",
              id: "getApiFunctions",
              function: {
                name: "getApiFunctions",
                arguments: JSON.stringify({}),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "getApiFunctions",
          content: JSON.stringify(
            operations.map((op) => ({
              name: op.name,
              description: op.function.description,
              ...(op.protocol === "http"
                ? {
                    method: op.function.method,
                    path: op.function.path,
                    tags: op.function.tags,
                  }
                : {}),
            })),
          ),
        },
        // PREVIOUS HISTORIES
        ...ctx.histories.map(ChatGptHistoryDecoder.decode).flat(),
        // USER INPUT
        {
          role: "user",
          content: ctx.prompt.text,
        },
        // SYSTEM PROMPT
        {
          role: "system",
          content: WrtnAgentSystemPrompt.SELECT,
        },
        // TYPE CORRECTIONS
        ...emendMessages(failures ?? []),
      ],
      // STACK FUNCTIONS
      tools: CONTAINER.functions.map(
        (func) =>
          ({
            type: "function",
            function: {
              name: func.name,
              description: func.description,
              parameters: func.parameters as any,
            },
          }) satisfies OpenAI.ChatCompletionTool,
      ),
      tool_choice: "auto",
      parallel_tool_calls: false,
    });

    //----
    // VALIDATION
    //----
    if (retry++ < (ctx.config?.retry ?? WrtnAgentConstant.RETRY)) {
      const failures: IFailure[] = [];
      for (const choice of completion.choices)
        for (const tc of choice.message.tool_calls ?? []) {
          if (tc.function.name !== "selectFunctions") continue;
          const input: object = JSON.parse(tc.function.arguments);
          const validation: IValidation<__IChatFunctionReference.IProps> =
            typia.validate<__IChatFunctionReference.IProps>(input);
          if (validation.success === false)
            failures.push({
              id: tc.id,
              name: tc.function.name,
              validation,
            });
        }
      if (failures.length > 0) return step(ctx, operations, retry, failures);
    }

    //----
    // PROCESS COMPLETION
    //----
    const prompts: IWrtnAgentPrompt[] = [];
    for (const choice of completion.choices) {
      // TOOL CALLING HANDLER
      if (choice.message.tool_calls)
        for (const tc of choice.message.tool_calls) {
          if (tc.type !== "function") continue;

          const input: __IChatFunctionReference.IProps = JSON.parse(
            tc.function.arguments,
          );
          if (typia.is(input) === false) continue;
          else if (tc.function.name === "selectFunctions") {
            const collection: IWrtnAgentPrompt.ISelect = {
              id: tc.id,
              type: "select",
              operations: [],
            };
            for (const reference of input.functions) {
              const operation: IWrtnAgentOperation | null =
                await selectFunction(ctx, reference);
              if (operation !== null)
                collection.operations.push(
                  WrtnAgentPromptFactory.selection({
                    protocol: operation.protocol as "http",
                    controller:
                      operation.controller as IWrtnAgentController.IHttp,
                    function: operation.function as IHttpLlmFunction<"chatgpt">,
                    name: operation.name,
                    reason: reference.reason,
                  }),
                );
            }
            if (collection.operations.length !== 0) prompts.push(collection);
          }
        }

      // ASSISTANT MESSAGE
      if (
        choice.message.role === "assistant" &&
        !!choice.message.content?.length
      ) {
        const text: IWrtnAgentPrompt.IText = {
          type: "text",
          role: "assistant",
          text: choice.message.content,
        };
        prompts.push(text);
        await ctx.dispatch(text);
      }
    }
    return prompts;
  };

  const selectFunction = async (
    ctx: IWrtnAgentContext,
    reference: __IChatFunctionReference,
  ): Promise<IWrtnAgentOperation | null> => {
    const operation: IWrtnAgentOperation | undefined = ctx.operations.flat.get(
      reference.name,
    );
    if (operation === undefined) return null;

    ctx.stack.push(
      WrtnAgentPromptFactory.selection({
        protocol: operation.protocol as "http",
        controller: operation.controller as IWrtnAgentController.IHttp,
        function: operation.function as IHttpLlmFunction<"chatgpt">,
        name: reference.name,
        reason: reference.reason,
      }),
    );
    await ctx.dispatch({
      type: "select",
      reason: reference.reason,
      operation,
    });
    return operation;
  };

  const emendMessages = (
    failures: IFailure[],
  ): OpenAI.ChatCompletionMessageParam[] =>
    failures
      .map((f) => [
        {
          role: "assistant",
          tool_calls: [
            {
              type: "function",
              id: f.id,
              function: {
                name: f.name,
                arguments: JSON.stringify(f.validation.data),
              },
            },
          ],
        } satisfies OpenAI.ChatCompletionAssistantMessageParam,
        {
          role: "tool",
          content: JSON.stringify(f.validation.errors),
          tool_call_id: f.id,
        } satisfies OpenAI.ChatCompletionToolMessageParam,
        {
          role: "system",
          content: [
            "You A.I. assistant has composed wrong typed arguments.",
            "",
            "Correct it at the next function calling.",
          ].join("\n"),
        } satisfies OpenAI.ChatCompletionSystemMessageParam,
      ])
      .flat();
}

const CONTAINER: ILlmApplication<"chatgpt"> = typia.llm.application<
  __IChatSelectFunctionsApplication,
  "chatgpt"
>();

interface IFailure {
  id: string;
  name: string;
  validation: IValidation.IFailure;
}
