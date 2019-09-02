import c from "config";
import { Client, ClientOptions, Message, RichEmbed } from "discord.js";
import process from "process";
import OuterXRegExp from "xregexp";

import ConniebotDatabase from "./helper/db-management";
import startup from "./helper/startup";
import { log, messageSummary } from "./helper/utils";
import { formatObject } from "./helper/utils/format";
import x2i from "./x2i";

export type CommandCallback =
  (this: Conniebot, message: Message, ...args: string[]) => Promise<any>;

export interface ICommands {
  [key: string]: CommandCallback;
}

export default class Conniebot {
  public bot: Client;
  public db: ConniebotDatabase;
  private commands: ICommands;

  constructor(token: string, dbFile: string, clientOptions?: ClientOptions) {
    log("verbose", "Starting to load bot...");

    this.bot = new Client(clientOptions);
    this.db = new ConniebotDatabase(dbFile);
    this.commands = {};

    this.bot.on("ready", () => startup(this.bot, this.db))
      .on("message", this.parse)
      .on("error", err => {
        if (err && err.message && err.message.includes("ECONNRESET")) {
          return log("warn", "connection reset. oops!");
        }
        this.panicResponsibly(err);
      })
      .login(token);

    process.once("uncaughtException", this.panicResponsibly);
  }

  /**
   * Record the error and proceed to crash.
   *
   * @param err The error to catch.
   * @param exit Should exit? (eg ECONNRESET would not require reset)
   */
  private panicResponsibly = async (err: any, exit = true) => {
    log("error", err);
    await this.db.addError(err);
    if (exit) {
      process.exit(1);
    }
  }

  /**
   * Looks for a reply message.
   *
   * @param message Received message.
   */
  private async command(message: Message) {
    // commands
    const prefixRegex = OuterXRegExp.build(
      `(?:^${OuterXRegExp.escape(c.get("prefix"))})(\\S*) ?(.*)`, [],
    );

    const toks = message.content.match(prefixRegex);
    if (!toks) return;
    const [, cmd, args] = toks;

    if (!(cmd in this.commands)) return;
    const cb = this.commands[cmd].bind(this);

    try {
      const logItem = await cb(message, ...args.split(" "));
      log(`success:command/${cmd}`, logItem === undefined ? "" : String(logItem));
    } catch (err) {
      log(`error:command/${cmd}`, err);
    }
  }

  /**
   * Sends an x2i string (but also could be used for simple embeds)
   *
   * @param message Message to reply to
   */
  private async x2iExec(message: Message) {
    const results = x2i(message.content);
    const parsed = Boolean(results && results.length !== 0);
    if (parsed) {
      let responses: (RichEmbed | string)[] = [results];
      let logCode = "all";

      // check timeout
      const charMax: number = c.get("timeoutChars");
      if (results.length > charMax) {
        const timeoutMessage = formatObject(
          c.get("timeoutMessage"),
          { user: message.client.user, config: c},
        );
        responses = [
          `${results.slice(0, charMax - 1)}…`,
          typeof timeoutMessage === "string"
            ? timeoutMessage
            : new RichEmbed(timeoutMessage),
        ];
        logCode = "partial";
      }

      const respond = (stat: string, ...ms: any[]) =>
        log(`${stat}:x2i/${logCode}`, messageSummary(message), ...ms);

      try {
        for (const response of responses) {
          await message.channel.send(response);
        }
        respond("success");
      } catch (err) {
        respond("error", err);
      }
    }

    return parsed;
  }

  /**
   * Acts for a response to a message.
   *
   * @param message Message to parse for responses
   */
  protected parse = async (message: Message) => {
    if (message.author.bot) return;
    if (await this.x2iExec(message)) return;
    await this.command(message);
  }

  /**
   * Register multiple commands at once.
   */
  public registerCommands(callbacks: ICommands) {
    for (const [name, cmd] of Object.entries(callbacks)) {
      this.register(name, cmd);
    }
  }

  /**
   * Register a single custom command.
   *
   * @param command Command name that comes after prefix. Name must be `\S+`.
   * @param callback Callback upon seeing the name. `this` will be bound automatically.
   */
  public register(command: string, callback: CommandCallback) {
    this.commands[command] = callback;
  }
}
