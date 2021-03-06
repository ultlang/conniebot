import { readdir, readFile } from "fs";
import path from "path";
import { promisify } from "util";

import { Client, ClientOptions, Message, MessageEmbed, MessageEmbedOptions, MessageReaction, PartialUser, User } from "discord.js";
import yaml from "js-yaml";
import process from "process";
import OuterXRegExp from "xregexp";

import ConniebotDatabase from "./helper/db-management";
import { notifyNewErrors, notifyRestart, updateActivity } from "./helper/startup";
import { log, messageSummary } from "./helper/utils";
import { formatObject } from "./helper/utils/format";
import X2IMatcher from "./x2i";

export type CommandCallback =
  (this: Conniebot, message: Message, ...args: string[]) => Promise<any>;

export interface IConniebotConfig {
  activeMessage: string;
  clientOptions?: ClientOptions;
  database: string;
  deleteEmoji: string;
  help: MessageEmbedOptions | string;
  owner: string;
  prefix: string;
  timeoutChars: number;
  timeoutMessage: MessageEmbedOptions | string;
  token: string;
  x2iFiles: string;
}

export interface ICommands {
  [key: string]: CommandCallback;
}

const readdirPromise = promisify(readdir);
const readFilePromise = promisify(readFile);

export default class Conniebot {
  public bot: Client;
  public db: ConniebotDatabase;
  public readonly config: IConniebotConfig;

  private commands: ICommands;
  private x2i?: X2IMatcher;

  private ready: boolean = false;

  constructor(config: IConniebotConfig) {
    log("verbose", "Starting to load bot...");

    this.config = config;

    this.bot = new Client(this.config.clientOptions);
    this.db = new ConniebotDatabase(this.config.database);
    this.commands = {};

    this.bot
      .on("ready", () => this.startup())
      .on("message", async message => {
        if (this.ready) {
          return this.parse(message);
        }
      })
      .on("error", err => {
        if (err && err.message && err.message.includes("ECONNRESET")) {
          return log("warn", "connection reset. oops!");
        }
        this.panicResponsibly(err);
      })
      .on("messageReactionAdd", async (message, user) => {
        if (this.ready) {
          return this.reactDeleteMessage(message, user);
        }
      })
      .login(this.config.token);

    process.once("uncaughtException", this.panicResponsibly);
  }

  private async startup() {
    log("info", "Bot ready. Setting up...");

    updateActivity(this.bot, this.config.activeMessage);
    notifyRestart(this.bot, this.db);
    notifyNewErrors(this.bot, this.db);

    this.x2i = await this.loadKeys();
    log("info", "Setup complete.");
    this.ready = true;
  }

  /**
   * Load keys from files in the x2i data folder.
   */
  private async loadKeys() {
    log("info", "Loading X2I keys from: \x1b[96m%s\x1b[0m...", this.config.x2iFiles);

    const x2iDir = this.config.x2iFiles;
    const x2iFiles = await readdirPromise(x2iDir);
    const x2iData = await Promise.all(x2iFiles.map(
      fname => readFilePromise(path.resolve(x2iDir, fname), "utf8"),
    ));

    log("info", "X2I keys have been loaded.");
    return new X2IMatcher(x2iData.map(d => yaml.safeLoad(d)));
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
      `(?:^${OuterXRegExp.escape(this.config.prefix)})(\\S*) ?(.*)`, [],
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
    const results = this.x2i ? this.x2i.search(message.content).join("\n") : "";
    const parsed = Boolean(results && results.length !== 0);
    if (parsed) {
      let responses: (MessageEmbed | string)[] = [results];
      let logCode = "all";

      // check timeout
      if (results.length > this.config.timeoutChars) {
        const timeoutMessage = formatObject(
          this.config.timeoutMessage,
          { user: message.client.user, config: this.config},
        );
        responses = [
          `${results.slice(0, this.config.timeoutChars)}…`,
          typeof timeoutMessage === "string" ? timeoutMessage : new MessageEmbed(timeoutMessage),
        ];
        logCode = "partial";
      }

      const respond = (stat: string, ...ms: any[]) =>
        log(`${stat}:x2i/${logCode}`, messageSummary(message), ...ms);

      try {
        const responseMessages = [];
        for (const response of responses) {
          const responseMessage = await message.channel.send(response);
          responseMessage.react(this.config.deleteEmoji); // don't care about response
          responseMessages.push(responseMessage);
        }
        await this.db.addMessage(message, responseMessages);
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
   * Acts for a reaction to potentially delete a message.
   * 
   * @param reaction Message reaction event.
   * @param user User that prompted reaction.
   */
  protected reactDeleteMessage = async (reaction: MessageReaction, user: User | PartialUser) => {
    if (user.id === this.bot.user?.id
        || user.id !== await this.db.getMessageAuthor(reaction.message)
        || reaction.emoji.name !== this.config.deleteEmoji) { return; }

    await reaction.message.delete();
    await this.db.deleteMessage(reaction.message);
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
