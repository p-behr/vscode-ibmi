
const path = require(`path`);
const vscode = require(`vscode`);

const IBMi = require(`./IBMi`);
const Configuration = require(`./Configuration`);
const Storage = require(`./Storage`);
const IBMiContent = require(`./IBMiContent`);

const ignore = require(`ignore`).default;

const gitExtension = vscode.extensions.getExtension(`vscode.git`).exports;

const DEPLOYMENT_KEY = `deployment`;

const BUTTON_BASE = `$(cloud-upload) Deploy`;
const BUTTON_WORKING = `$(sync~spin) Deploying`;

module.exports = class Deployment {
  /**
   * 
   * @param {vscode.ExtensionContext} context 
   * @param {*} instance 
   */
  constructor(context, instance) {
    this.instance = instance;
    
    this.deploymentLog = vscode.window.createOutputChannel(`IBM i Deployment`);

    /** @type {vscode.StatusBarItem} */
    this.button = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    this.button.command = {
      command: `code-for-ibmi.launchDeploy`,
      title: `Launch Deploy`
    }
    this.button.text = BUTTON_BASE;

    context.subscriptions.push(this.button, this.deploymentLog);

    if (vscode.workspace.workspaceFolders) {
      if (vscode.workspace.workspaceFolders.length > 0) {
        vscode.commands.executeCommand(`setContext`, `code-for-ibmi:workspace`, true);
        this.button.show();
      }
    }

    context.subscriptions.push(
      /**
       * @param {number} document
       * @returns {Promise<{false|{workspace: number}}>}
       */
      vscode.commands.registerCommand(`code-for-ibmi.launchDeploy`, async (workspaceIndex) => {

        /** @type {IBMi} */
        const connection = instance.getConnection();

        /** @type {Storage} */
        const storage = instance.getStorage();

        /** @type {IBMiContent} */
        const content = instance.getContent();
        
        let folder;

        /** @type {string[]} */
        const sourceFilesCreated = [];

        if (workspaceIndex) {
          folder = vscode.workspace.workspaceFolders.find(dir => dir.index === workspaceIndex);
        } else {
          folder = await Deployment.getWorkspaceFolder();
        }

        if (folder) {
          const existingPaths = storage.get(DEPLOYMENT_KEY) || {};
          const remotePath = existingPaths[folder.uri.fsPath];

          if (remotePath) {
            const method = await vscode.window.showQuickPick(
              [`Working Changes`, `Staged Changes`, `All`],
              { placeHolder: `Select deployment method to ${remotePath}` }
            );

            if (method) {
              /** @type {IBMi} */
              const ibmi = instance.getConnection();

              /** @type {Configuration} */
              const config = instance.getConfig();

              const isIFS = remotePath.startsWith(`/`);

              if (isIFS) {
                if (config.homeDirectory !== remotePath) {
                  await config.set(`homeDirectory`, remotePath);
                  vscode.window.showInformationMessage(`Home directory set to ${remotePath} for deployment.`);
                }
              }

              const client = ibmi.client;
              this.deploymentLog.clear();

              let useStagedChanges = true;
              let changeType = `staged`;
              switch (method) {
              case `Working Changes`:
                useStagedChanges = false;
                changeType = `working`;
              case `Staged Changes`: // Uses git
                let gitApi;

                try {
                  gitApi = gitExtension.getAPI(1);
                } catch (e) {
                  vscode.window.showErrorMessage(`Unable to get git API.`);
                  return false;
                }

                if (gitApi.repositories.length > 0) {
                  const repository = gitApi.repositories.find(r => r.rootUri.fsPath === folder.uri.fsPath);

                  if (repository) {
                    let changes;
                    if (useStagedChanges) {
                      changes = await repository.state.indexChanges;
                    }
                    else {
                      changes = await repository.state.workingTreeChanges;
                    }
                    
                    if (changes.length > 0) {
                      const uploads = changes.map(change => {
                        const relative = path.relative(folder.uri.path, change.uri.path).replace(new RegExp(`\\\\`, `g`), `/`);
                        const remote = path.posix.join(remotePath, relative);
                        return {
                          local: change.uri._fsPath,
                          remote: remote,
                          uri: change.uri
                        };
                      });
                    
                      this.button.text = BUTTON_WORKING;

                      vscode.window.showInformationMessage(`Deploying ${changeType} changes (${uploads.length}) to ${remotePath}`);

                      try {
                        if (isIFS) {
                          await client.putFiles(uploads, {
                            concurrency: 5
                          });
                        } else {
                          // Upload changes to QSYS
                          const uploadUris = uploads.map(upload => upload.uri);
                          let index = 0;

                          for (const uri of uploadUris) {
                            const relative = path.relative(folder.uri.fsPath, uri.fsPath);
                            const pathParts = relative.toUpperCase().split(path.sep);
                            const baseInfo = path.parse(relative);
      
                            index += 1;
      
                            // directory / file.ext
                            if (pathParts.length === 2 && pathParts[0].match(/^[A-Z]/i)) {
                              if (baseInfo.ext.length > 1) {

                                if (!sourceFilesCreated.includes(pathParts[0])) {
                                  sourceFilesCreated.push(pathParts[0]);
                                  try {
                                    await connection.remoteCommand(`CRTSRCPF FILE(${remotePath}/${pathParts[0]}) RCDLEN(112)`);
                                  } catch (e) {
                                  // We likely don't care that it fails.
                                  }
                                }
      
                                try {
                                  await connection.remoteCommand(`ADDPFM FILE(${remotePath}/${pathParts[0]}) MBR(${baseInfo.name}) SRCTYPE(${baseInfo.ext.substring(1)})`);
                                } catch (e) {
                                  // We likely don't care that it fails. It might already exist?
                                }
      
                                const fileContent = await vscode.workspace.fs.readFile(uri);
                                await content.uploadMemberContent(undefined, remotePath, pathParts[0], baseInfo.name, fileContent);
    
                                this.deploymentLog.appendLine(`SUCCESS: ${relative} -> ${[remotePath, pathParts[0], baseInfo.name].join(`,`)}`);
                              }
                            } else {
                              // Bad extension
                            }
                          }
                        }
                        this.button.text = BUTTON_BASE;
                        this.deploymentLog.appendLine(`Deployment finished.`);
                        vscode.window.showInformationMessage(`Deployment finished.`);

                        return folder.index;
                      } catch (e) {
                        this.button.text = BUTTON_BASE;
                        vscode.window.showErrorMessage(`Deployment failed.`, `View Log`).then(async (action) => {
                          if (action === `View Log`) {
                            this.deploymentLog.show();
                          }
                        });
                      
                        this.deploymentLog.appendLine(`Deployment failed.`);
                        this.deploymentLog.appendLine(e);
                      }

                    } else {
                      vscode.window.showWarningMessage(`No ${changeType} changes to deploy.`);
                    }

                  } else {
                    vscode.window.showErrorMessage(`No repository found for ${folder.uri.fsPath}`);
                  }
                } else {
                  vscode.window.showErrorMessage(`No repositories are open.`);
                }

                break;

              case `All`: // Uploads entire directory
                this.button.text = BUTTON_WORKING;
                
                // get the .gitignore file from workspace
                const gitignores = await vscode.workspace.findFiles(`**/.gitignore`, ``, 1);

                let ignoreRules = ignore({ignorecase: true}).add(`.git`);

                if (gitignores.length > 0) {
                  // get the content from the file
                  const gitignoreContent = await (await vscode.workspace.fs.readFile(gitignores[0])).toString().replace(new RegExp(`\\\r`, `g`), ``);
                  ignoreRules.add(gitignoreContent.split(`\n`));
                }

                const uploadResult = await vscode.window.withProgress({
                  location: vscode.ProgressLocation.Notification,
                  title: `Deploying to ${folder.name}`,
                }, async (progress) => {
                  progress.report({ message: `Deploying to ${folder.name}` });
                  if (isIFS) {
                    try {
                      await client.putDirectory(folder.uri.fsPath, remotePath, {
                        recursive: true,
                        concurrency: 5,
                        tick: (localPath, remotePath, error) => {
                          if (error) {
                            progress.report({ message: `Failed to deploy ${localPath}` });
                            this.deploymentLog.appendLine(`FAILED: ${localPath} -> ${remotePath}: ${error.message}`);
                          } else {
                            progress.report({ message: `Deployed ${localPath}` });
                            this.deploymentLog.appendLine(`SUCCESS: ${localPath} -> ${remotePath}`);
                          }
                        },
                        validate: (localPath, remotePath) => {
                          if (ignoreRules) {
                            const relative = path.relative(folder.uri.fsPath, localPath);
                            return !ignoreRules.ignores(relative);
                          }

                          return true;
                        }
                      });

                      progress.report({ message: `Deployment finished.` });
                      this.deploymentLog.appendLine(`Deployment finished.`);

                      return true;
                    } catch (e) {
                      progress.report({ message: `Deployment failed.` });
                      this.deploymentLog.appendLine(`Deployment failed`);
                      this.deploymentLog.appendLine(e);

                      return false;
                    }
                  } else {
                    // Upload/write to QSYS
                    const uploads = await vscode.workspace.findFiles(`**`, ``);

                    let index = -1;

                    for (const uri of uploads) {
                      const relative = path.relative(folder.uri.fsPath, uri.fsPath);
                      const pathParts = relative.toUpperCase().split(path.sep);
                      const baseInfo = path.parse(relative);

                      index += 1;

                      // directory / file.ext
                      if (pathParts.length === 2 && pathParts[0].match(/^[A-Z]/i)) {
                        if (ignoreRules) {
                          if (ignoreRules.ignores(relative)) {
                            // Skip because it's part of the .gitignore
                            continue;
                          }
                        }

                        if (pathParts[0].length <= 10 && baseInfo.name.length <= 10 && baseInfo.ext.length > 1) {
                          progress.report({ message: `Deploying ${relative} (${index + 1}/${uploads.length})` });

                          if (!sourceFilesCreated.includes(pathParts[0])) {
                            sourceFilesCreated.push(pathParts[0]);
                            try {
                              await connection.remoteCommand(`CRTSRCPF FILE(${remotePath}/${pathParts[0]}) RCDLEN(112)`);
                            } catch (e) {
                            // We likely don't care that it fails.
                            }
                          }

                          try {
                            await connection.remoteCommand(`ADDPFM FILE(${remotePath}/${pathParts[0]}) MBR(${baseInfo.name}) SRCTYPE(${baseInfo.ext.substring(1)})`);
                          } catch (e) {
                            // We likely don't care that it fails. It might already exist?
                          }

                          try {
                            const fileContent = await vscode.workspace.fs.readFile(uri);
                            await content.uploadMemberContent(undefined, remotePath, pathParts[0], baseInfo.name, fileContent);

                            progress.report({ message: `Deployed ${relative}` });
                            this.deploymentLog.appendLine(`SUCCESS: ${relative} -> ${[remotePath, pathParts[0], baseInfo.name].join(`/`)}`);

                          } catch (error) {
                            // Failed to upload a file. Fail deploy.
                            progress.report({ message: `Failed to deploy ${relative}` });
                            this.deploymentLog.appendLine(`FAILED: ${relative} -> ${[remotePath, pathParts[0], baseInfo.name].join(`/`)}: ${error}`);
                            return false;
                          }
                        } else {
                          this.deploymentLog.appendLine(`SKIPPED: ${relative}}`);
                        }
                      } else {
                        // Bad extension
                      }
                    }

                    progress.report({ message: `Deployment finished.` });
                    this.deploymentLog.appendLine(`Deployment finished.`);

                    // All good uploading!
                    return true;
                  }
                });

                this.button.text = BUTTON_BASE;
                if (uploadResult) {
                  vscode.window.showInformationMessage(`Deployment finished.`);
                  return folder.index;
                  
                } else {
                  vscode.window.showErrorMessage(`Deployment failed.`, `View Log`).then(async (action) => {
                    if (action === `View Log`) {
                      this.deploymentLog.show();
                    }
                  });
                }

                break;
              }
            }
          } else {
            vscode.window.showErrorMessage(`Chosen location (${folder.uri.fsPath}) is not configured for deployment.`);
          }
        } else {
          vscode.window.showErrorMessage(`No location selected for deployment.`);
        }

        return false;
      }),

      vscode.commands.registerCommand(`code-for-ibmi.setDeployLocation`, async (node) => {
        let path;
        if (node) {
          // Directory or filter can be chosen
          path = node.path;
        } else {
          path = await vscode.window.showInputBox({
            prompt: `Enter IFS directory to deploy to`,
          });
        }

        if (path) {
          /** @type {Storage} */
          const storage = instance.getStorage();

          const chosenWorkspaceFolder = await Deployment.getWorkspaceFolder();

          if (chosenWorkspaceFolder) {
            const existingPaths = storage.get(DEPLOYMENT_KEY) || {};
            existingPaths[chosenWorkspaceFolder.uri.fsPath] = path;
            await storage.set(DEPLOYMENT_KEY, existingPaths);

            vscode.window.showInformationMessage(`Deployment location set to ${path}`, `Deploy now`).then(async (choice) => {
              if (choice === `Deploy now`) {
                vscode.commands.executeCommand(`code-for-ibmi.launchDeploy`, chosenWorkspaceFolder.index);
              }
            });
          }
        }
      }),
    );
  }

  initialise(instance) {
    const workspaces = vscode.workspace.workspaceFolders;

    /** @type {IBMi} */
    const connection = instance.getConnection();
    /** @type {Configuration} */
    const config = instance.getConfig();
    /** @type {Storage} */
    const storage = instance.getStorage();

    const existingPaths = storage.get(DEPLOYMENT_KEY) || {};

    if (workspaces.length === 1) {
      const workspace = workspaces[0];

      if (!existingPaths[workspace.uri.fsPath]) {
        const possibleDeployDir = path.posix.join(`/`, `home`, connection.currentUser, `builds`, workspace.name);
        vscode.window.showInformationMessage(
          `Deploy directory for Workspace not setup. Would you like to default to '${possibleDeployDir}'?`, 
          `Yes`, 
          `Ignore`
        ).then(async result => {
          if (result === `Yes`) {
            await connection.sendCommand({
              command: `mkdir -p "${possibleDeployDir}"`
            });

            existingPaths[workspace.uri.fsPath] = possibleDeployDir;
            try {
              await storage.set(DEPLOYMENT_KEY, existingPaths);
            } catch (e) {
              console.log(e);
            }
          }
        });
      }

      vscode.window.showInformationMessage(
        `Current library is set to ${config.currentLibrary}.`,
        `Change`
      ).then(result => {
        if (result === `Change`)
          vscode.commands.executeCommand(`code-for-ibmi.changeCurrentLibrary`);
      });
    }
  }

  static async getWorkspaceFolder() {
    const workspaces = vscode.workspace.workspaceFolders;

    if (workspaces.length > 0) {
      if (workspaces.length === 1) {
        return workspaces[0];
      } else {
        const chosen = await vscode.window.showQuickPick(workspaces.map(dir => dir.name), {
          placeHolder: `Select workspace to deploy`
        });

        if (chosen) {
          return workspaces.find(dir => dir.name === chosen);
        }

        return null;
      }
    }

    return null;
  }
}