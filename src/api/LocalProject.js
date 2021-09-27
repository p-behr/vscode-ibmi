
const vscode = require(`vscode`);
const path = require(`path`);
const IBMi = require(`./IBMi`);
const IBMiContent = require(`./IBMiContent`);
const Configuration = require(`./Configuration`);

const CompileTools = require(`./CompileTools`);

let projectEnabled = false;

module.exports = class LocalProject {
  static async init() {
    if (LocalProject.hasWorkspace()) {
      const configExists = await LocalProject.configExists();

      if (configExists) {
        projectEnabled = true;
      } else {
        const isProject = await vscode.window.showInformationMessage(`Is this workspace an IBM i project?`, `Yes`, `No`);

        if (isProject === `Yes`) {
          projectEnabled = true;

          vscode.window.showInformationMessage(`Creating default configuration file.`);
          await LocalProject.createConfig();
        }
      }
    }
  }

  static hasWorkspace() {
    return vscode.workspace.workspaceFolders.length === 1;
  }

  static getWorkspaceFolder() {
    if (LocalProject.hasWorkspace()) {
      return vscode.workspace.workspaceFolders[0];
    }
  }

  static async configValid(config) {
    if (config.objlib && config.actions && config.actions.length > 0) {
      return true;
    }

    return false;
  }

  static async configExists() {
    const workspace = LocalProject.getWorkspaceFolder();
    const folderUri = workspace.uri;
    const jsonUri = folderUri.with({ path: path.join(folderUri.path, `iproj.json`) });

    try {
      await vscode.workspace.fs.stat(jsonUri);
      return true;
    } catch (err) {
      return false;
    }
  }

  static async envExists() {
    const workspace = LocalProject.getWorkspaceFolder();
    const folderUri = workspace.uri;
    const envUri = folderUri.with({ path: path.join(folderUri.path, `.env`) });

    try {
      await vscode.workspace.fs.stat(envUri);
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * Before calling this, call hasWorkspace() first.
   * @returns {Promise<{
   *    objlib: string, 
   *    actions: {name: string, command: string, fileSystem: "qsys"|"ifs", commandEnvironment: "qsys", extensions: string[]}[]
   * }>}
   */
  static async getConfig() {
    const workspace = LocalProject.getWorkspaceFolder();
    const folderUri = workspace.uri;
    let readData, readStr;

    let config;

    if (await LocalProject.configExists()) {
    // First we get the json configuration for the local project
      const jsonUri = folderUri.with({ path: path.join(folderUri.path, `iproj.json`) });

      readData = await vscode.workspace.fs.readFile(jsonUri);
      readStr = Buffer.from(readData).toString(`utf8`);

      const env = await this.getEnvConfig();

      for (const envVar in env) {
        readStr = readStr.replace(new RegExp(`&${envVar.toUpperCase()}`, `g`), env[envVar]);
      }

      try {
        config = JSON.parse(readStr);
      } catch (e) {
        vscode.window.showErrorMessage(`The configuration file is not valid JSON.`);
        config = {};
      }
    }

    return config;
  }

  /** @returns {Promise<{[name: string]: string}>} */
  static async getEnvConfig() {
    let env = {};

    if (await this.envExists()) {
      const workspace = LocalProject.getWorkspaceFolder();
      const folderUri = workspace.uri;
      let readData, readStr;

      // Then we get the local .env file
      const envUri = folderUri.with({ path: path.join(folderUri.path, `.env`) });
      readData = await vscode.workspace.fs.readFile(envUri);
      readStr = Buffer.from(readData).toString(`utf8`);

      const envLines = readStr.replace(new RegExp(`\\\r`, `g`), ``).split(`\n`);

      // Parse out the env lines
      envLines.forEach(line => {
        if (!line.startsWith(`#`)) {
          const [key, value] = line.split(`=`);
          if (key.length > 0 && value.length > 0) {
            env[key] = value;
          }
        }
      });
    }

    // @ts-ignore
    return env;
  }

  static async createConfig() {
    const workspace = LocalProject.getWorkspaceFolder();
    const folderUri = workspace.uri;
    const jsonUri = folderUri.with({ path: path.join(folderUri.path, `iproj.json`) });

    const config = {
      version: `0.0.1`,
      description: `IBM i Project`,
      repository: ``,
      objlib: `&DEVLIB`,
      curlib: `&DEVLIB`,
      includePath: [],
      preUsrlibl: [],
      postUsrlibl: [],
      setIBMiEnvCmd: [],
      actions: [
        {
          name: `Compile: CRTSQLRPGI (Program)`,
          command: `CRTSQLRPGI OBJ(&OBJLIB/&NAME) SRCFILE(&OBJLIB/&FOLDER) CLOSQLCSR(*ENDMOD) OPTION(*EVENTF) DBGVIEW(*SOURCE) TGTRLS(*CURRENT)`,
          fileSystem: `qsys`,
          commandEnvironment: `qsys`,
          extensions: [`sqlrpgle`]
        },
        {
          name: `Compile: CRTBNDRPG`,
          command: `CRTBNDRPG PGM(&OBJLIB/&NAME) SRCFILE(&OBJLIB/&FOLDER) SRCMBR(&NAME) OPTION(*EVENTF) DBGVIEW(*SOURCE)`,
          fileSystem: `qsys`,
          commandEnvironment: `qsys`,
          extensions: [`rpgle`]
        },
        {
          name: `Compile: CRTRPGMOD`,
          command: `CRTRPGMOD MOD(&OBJLIB/&NAME) SRCFILE(&OBJLIB/&FOLDER) SRCMBR(&NAME) OPTION(*EVENTF) DBGVIEW(*SOURCE)`,
          fileSystem: `qsys`,
          commandEnvironment: `qsys`,
          extensions: [`rpgle`]
        },
        {
          name: `Compile: CRTBNDCBL`,
          command: `CRTBNDCBL (&OBJLIB/&NAME) SRCFILE(&OBJLIB/&FOLDER) OPTION(*SOURCE *EVENTF) DBGVIEW(*SOURCE)`,
          fileSystem: `qsys`,
          commandEnvironment: `qsys`,
          extensions: [`cbl`, `cbble`, `cob`]
        },
        {
          name: `Compile: CRTCMD`,
          command: `CRTCMD CMD(&OBJLIB/&NAME) PGM(&OBJLIB/&NAME) SRCFILE(&OBJLIB/&FOLDER) ALLOW(*ALL) CURLIB(*NOCHG) PRDLIB(*NOCHG)`,
          fileSystem: `qsys`,
          commandEnvironment: `qsys`,
          extensions: [`cmd`]
        },
        {
          name: `Compile: CRTBNDCL`,
          command: `CRTBNDCL PGM(&OBJLIB/&NAME) SRCFILE(&OBJLIB/&FOLDER) OPTION(*EVENTF) DBGVIEW(*SOURCE)`,
          fileSystem: `qsys`,
          commandEnvironment: `qsys`,
          extensions: [`cl`, `clle`]
        },
        {
          name: `Compile: CRTPGM`,
          command: `CRTPGM PGM(&OBJLIB/&NAME) MODULE(*PGM) ENTMOD(*FIRST) BNDSRVPGM(*NONE) BNDDIR(*NONE) ACTGRP(*ENTMOD) TGTRLS(*CURRENT)`,
          fileSystem: `qsys`,
          commandEnvironment: `qsys`
        },
      ]
    };

    const jsonStr = JSON.stringify(config, null, 2);

    await vscode.workspace.fs.writeFile(jsonUri, Buffer.from(jsonStr, `utf8`));

    const envExists = await LocalProject.envExists();

    if (!envExists) {
      const envContent = [
        `# THIS FILE BELONGS IN THE .gitignore!`,
        `# Variables for the local IBM i project`,
        `# This file is automatically generated by Code for IBM i`,
        ``,
        `# DEVLIB is referenced in the ./iproj.json config file.`,
        `# .env allows developers to each configure where to build their objects`,
        `DEVLIB=DEVLIB`
      ].join(`\n`);

      await vscode.workspace.fs.writeFile(folderUri.with({ path: path.join(folderUri.path, `.env`) }), Buffer.from(envContent, `utf8`));
    }
  }

  /**
   * @param {*} instance 
   * @param {vscode.Uri} documentUri 
   */
  static async RunAction(instance, documentUri) {
    /** @type {IBMi} */
    const connection = instance.getConnection();

    /** @type {Configuration} */
    const config = instance.getConfig();

    if (projectEnabled) {
      const pathInfo = path.parse(documentUri.fsPath);
      const folder = path.basename(pathInfo.dir); // Get the parent directory name
      const name = pathInfo.name.toUpperCase();
      const ext = pathInfo.ext.substring(1);

      if (folder.length > 10) {
        vscode.window.showErrorMessage(`The folder name ${folder} is too long to map to an IBM i source file. (10 characters max)`);
        return;
      }

      if (name.length > 10) {
        vscode.window.showErrorMessage(`The file name ${name} is too long to map to an IBM i source member. (10 characters max)`);
        return;
      }

      if (ext.length > 6) {
        vscode.window.showErrorMessage(`The extension for ${name}.${ext} is too long to map to a source type. (6 characters max)`);
        return;
      }

      const configExists = await LocalProject.configExists();

      if (configExists) {
        const projConfig = await LocalProject.getConfig();
        const env = await LocalProject.getEnvConfig();

        if (await LocalProject.configValid(projConfig)) {

          const availableActions = projConfig.actions
            .filter(action => action.extensions === undefined || (action.extensions.length > 0 && action.extensions.includes(ext)))
            .map(action => action.name)
          const chosenOptionName = await vscode.window.showQuickPick(availableActions);

          if (chosenOptionName) {
            const action = projConfig.actions.find(action => action.name === chosenOptionName);

            // 1. We find all the possible deps in the active editor
            const fileList = await vscode.workspace.findFiles(`**/*.*`);

            const docBytes = await vscode.workspace.fs.readFile(documentUri);
            const content = Buffer.from(docBytes).toString(`utf8`).toUpperCase();
        
            /** @type {vscode.Uri[]} */
            let allUploads = [documentUri];

            fileList.forEach(file => {
              const basename = path.parse(file.fsPath).name.toUpperCase();
              if (content.includes(basename)) {
                allUploads.push(file);
              }
            });

            // 2. We upload all the files
            CompileTools.appendToOutputChannel(`Uploading ${allUploads.length} files...\n`);
            CompileTools.appendToOutputChannel(allUploads.map(file => `\t` + path.basename(file.fsPath)).join(`\n`) + `\n\n`);

            try {
              switch (action.fileSystem) {
              case `qsys`:
                await LocalProject.uploadQsys(projConfig, allUploads, instance);
                break;
              }
            } catch (e) {
              vscode.window.showErrorMessage(`Failed to upload files to system.`);
              return;
            }

            // 3. We build the command and the library list

            let command = action.command;

            command = command.replace(new RegExp(`&OBJLIB`, `g`), projConfig.objlib.toUpperCase());
            command = command.replace(new RegExp(`&FOLDER`, `g`), folder);
            command = command.replace(new RegExp(`&NAME`, `g`), name);
            command = command.replace(new RegExp(`&EXT`, `g`), ext);

            for (const envVar in env) {
              command = command.replace(new RegExp(`&${envVar.toUpperCase()}`, `g`), env[envVar]);
            }

            const compileInfo = {
              lib: projConfig.objlib.toUpperCase(),
              object: pathInfo.name.toUpperCase(),
              localFiles: allUploads
            };

            let libl = config.libraryList.slice(0).reverse();

            libl = libl.map(library => {
            //We use this for special variables in the libl
              switch (library) {
              case `&DEVLIB`: return projConfig.objlib;
              case `&CURLIB`: return config.currentLibrary;
              default: return library;
              }
            });


            CompileTools.appendToOutputChannel(`Current library: ` + config.currentLibrary + `\n`);
            CompileTools.appendToOutputChannel(`   Library list: ` + config.libraryList.join(` `) + `\n`);
            CompileTools.appendToOutputChannel(`        Command: ` + command + `\n`);

            // 4. We run the command

            /** @type {any} */
            let commandResult, output = ``;

            try {
              switch (action.commandEnvironment) {
              case `qsys`:
                command = `system ${Configuration.get(`logCompileOutput`) ? `` : `-s`} "${command}"`;
                commandResult = await connection.qshCommand([
                  `liblist -d ` + connection.defaultUserLibraries.join(` `),
                  `liblist -c ` + config.currentLibrary,
                  `liblist -a ` + libl.join(` `),
                  command,
                ], undefined, 1);
                break;
              
              default:
                vscode.window.showErrorMessage(`Unsupported command environment: ${action.commandEnvironment}`);
                return;
            
              }

              if (commandResult.code === 0 || commandResult.code === null) {
                vscode.window.showInformationMessage(`Action ${chosenOptionName} for ${compileInfo.lib}/${compileInfo.object} was successful.`);
                if (Configuration.get(`autoRefresh`)) vscode.commands.executeCommand(`code-for-ibmi.refreshObjectList`, compileInfo.lib);
                
              } else {
                vscode.window.showErrorMessage(`Action ${chosenOptionName} for ${compileInfo.lib}/${compileInfo.object} was not successful.`);
              }

              if (commandResult.stderr.length > 0) output += `${commandResult.stderr}\n\n`;
              if (commandResult.stdout.length > 0) output += `${commandResult.stdout}\n\n`;

            } catch (e) {
              output = `${e}\n`;
              vscode.window.showErrorMessage(`Action ${chosenOptionName} for ${compileInfo.lib}/${compileInfo.object} failed. (internal error).`);
            }

            CompileTools.appendToOutputChannel(output);

            if (command.includes(`*EVENTF`)) {
              CompileTools.refreshDiagnostics(instance, compileInfo);
            }
          }

        } else {
          vscode.window.showWarningMessage(`iproj.json configuration is incorrect.`);
        }
        
      } else {
        vscode.window.showInformationMessage(`No iproj.json file found. Would you like to create one?`, `Yes`).then(async result => {
          if (result === `Yes`) {
            await LocalProject.createConfig();
          }
        });
      }
    }
  }

  /**
   * Uploads a set of files to the IBM i to the qsys env
   * @param {{objlib: string}} config
   * @param {vscode.Uri[]} files 
   * @param {*} instance 
   */
  static async uploadQsys(config, files, instance) {
    let creations = [];
    let uploads = [];

    /** @type {IBMi} */
    const connection = instance.getConnection();

    /** @type {IBMiContent} */
    const content = instance.getContent();

    const workspace = vscode.workspace;

    const fs = vscode.workspace.fs;

    for (const file of files) {
      const pathInfo = path.parse(file.fsPath);
      const name = pathInfo.name; //Member name
      const folder = path.basename(pathInfo.dir); //Get the parent directory name
      const extension = pathInfo.ext;

      const bytes = await fs.readFile(file);

      creations.push(connection.paseCommand(`system -s "ADDPFM FILE(${config.objlib}/${folder}) MBR(${name}) SRCTYPE(${extension})"`, undefined, 1));
      uploads.push(content.uploadMemberContent(undefined, config.objlib, folder, name, Buffer.from(bytes).toString(`utf8`)));
    }

    await Promise.all(creations);
    await Promise.all(uploads);
  }
  
}