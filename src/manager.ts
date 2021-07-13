import * as vscode from 'vscode';
import { BrowserPreview } from './editorPreview/browserPreview';
import { Disposable } from './utils/dispose';
import { Server } from './server/serverManager';
import { INIT_PANEL_TITLE, HOST, DONT_SHOW_AGAIN } from './utils/constants';
import {
	ServerStartedStatus,
	ServerTaskProvider,
} from './task/serverTaskProvider';
import {
	Settings,
	SETTINGS_SECTION_ID,
	SettingUtil,
} from './utils/settingsUtil';
import TelemetryReporter from 'vscode-extension-telemetry';
import { EndpointManager } from './infoManagers/endpointManager';
import { WorkspaceManager } from './infoManagers/workspaceManager';
import { ConnectionManager } from './infoManagers/connectionManager';

export interface serverMsg {
	method: string;
	url: string;
	status: number;
}

export interface launchInfo {
	external: boolean;
	file: string;
	relative: boolean;
	panel?: vscode.WebviewPanel;
}
export class Manager extends Disposable {
	public currentPanel: BrowserPreview | undefined;
	private readonly _server: Server;
	private _serverTaskProvider: ServerTaskProvider;
	private _previewActive = false;
	private _currentTimeout: NodeJS.Timeout | undefined;
	private _notifiedAboutLooseFiles = false;
	private _endpointManager: EndpointManager;
	private _workspaceManager: WorkspaceManager;
	private _connectionManager: ConnectionManager;
	private _pendingLaunchInfo: launchInfo | undefined;
	private _runTaskWithExternalPreview: boolean;

	private get _serverPort() {
		return this._connectionManager.httpPort;
	}

	public get workspace(): vscode.WorkspaceFolder | undefined {
		return this._workspaceManager.workspace;
	}

	public get workspacePath(): string | undefined {
		return this._workspaceManager.workspacePath;
	}

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _reporter: TelemetryReporter
	) {
		super();

		this._workspaceManager = this._register(new WorkspaceManager());
		this._endpointManager = this._register(
			new EndpointManager(this._workspaceManager)
		);
		const serverPort = SettingUtil.GetConfig(_extensionUri).portNumber;
		const serverWSPort = serverPort;
		this._connectionManager = this._register(
			new ConnectionManager(serverPort, serverWSPort)
		);

		this._server = this._register(
			new Server(
				_extensionUri,
				this._endpointManager,
				_reporter,
				this._workspaceManager,
				this._connectionManager
			)
		);

		this._serverTaskProvider = new ServerTaskProvider(
			this._reporter,
			this._endpointManager,
			this._workspaceManager
		);

		this._runTaskWithExternalPreview =
			SettingUtil.GetConfig(_extensionUri).runTaskWithExternalPreview;

		this._register(
			vscode.tasks.registerTaskProvider(
				ServerTaskProvider.CustomBuildScriptType,
				this._serverTaskProvider
			)
		);

		this._register(
			this._server.onNewReqProcessed((e) => {
				this._serverTaskProvider.sendServerInfoToTerminal(e);
			})
		);

		this._register(
			this._serverTaskProvider.onRequestToOpenServer(() => {
				this.openServer(true);
			})
		);

		this._register(
			this._serverTaskProvider.onRequestToCloseServer(() => {
				if (this._previewActive) {
					this._serverTaskProvider.serverStop(false);
				} else {
					this.closeServer();
					this._serverTaskProvider.serverStop(true);
				}
			})
		);

		this._connectionManager.onConnected((e) => {
			this._serverTaskProvider.serverStarted(
				e.httpURI,
				ServerStartedStatus.JUST_STARTED
			);

			if (this._pendingLaunchInfo) {
				if (this._pendingLaunchInfo.external) {
					this.launchFileInExternalBrowser(
						this._pendingLaunchInfo.file,
						this._pendingLaunchInfo.relative
					);
				} else {
					this.launchFileInEmbeddedPreview(
						this._pendingLaunchInfo.file,
						this._pendingLaunchInfo.relative,
						this._pendingLaunchInfo.panel
					);
				}
				this._pendingLaunchInfo = undefined;
			}
		});

		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration(SETTINGS_SECTION_ID)) {
				this._server.updateConfigurations();
				this._connectionManager.pendingPort = SettingUtil.GetConfig(
					this._extensionUri
				).portNumber;
				this._runTaskWithExternalPreview = SettingUtil.GetConfig(
					this._extensionUri
				).runTaskWithExternalPreview;
			}
		});

		this._serverTaskProvider.onRequestOpenEditorToSide((uri) => {
			if (this._previewActive && this.currentPanel) {
				const avoidColumn =
					this.currentPanel.panel.viewColumn ?? vscode.ViewColumn.One;
				const column: vscode.ViewColumn =
					avoidColumn == vscode.ViewColumn.One
						? avoidColumn + 1
						: avoidColumn - 1;
				vscode.commands.executeCommand('vscode.open', uri, {
					viewColumn: column,
				});
			} else {
				vscode.commands.executeCommand('vscode.open', uri);
			}
		});
	}

	dispose() {
		this._server.closeServer();
	}

	public createOrShowEmbeddedPreview(
		panel: vscode.WebviewPanel | undefined = undefined,
		file = '/',
		relative = true
	): void {
		if (!this._server.isRunning) {
			this._pendingLaunchInfo = {
				external: false,
				panel: panel,
				file: file,
				relative: relative,
			};
			this.openServer();
		} else {
			this.launchFileInEmbeddedPreview(file, relative, panel);
		}
	}

	public showPreviewInBrowser(file = '/', relative = true) {
		if (!this._serverTaskProvider.isRunning) {
			if (!this._server.isRunning) {
				this._pendingLaunchInfo = {
					external: true,
					file: file,
					relative: relative,
				};
			} else {
				this.launchFileInExternalBrowser(file, relative);
			}
			if (this.workspace && this._runTaskWithExternalPreview) {
				this._serverTaskProvider.extRunTask(
					SettingUtil.GetConfig(this._extensionUri)
						.browserPreviewLaunchServerLogging
				);
			} else {
				// global tasks are currently not supported, just turn on server in this case.
				const serverOn = this.openServer();

				if (!serverOn) {
					return;
				}
			}
		} else {
			this.launchFileInExternalBrowser(file, relative);
		}
	}

	public openServer(fromTask = false): boolean {
		if (!this._server.isRunning) {
			return this._server.openServer(this._serverPort);
		} else if (fromTask) {
			this._connectionManager.resolveExternalHTTPUri().then((uri) => {
				this._serverTaskProvider.serverStarted(
					uri,
					ServerStartedStatus.STARTED_BY_EMBEDDED_PREV
				);
			});
		}

		return true;
	}

	// caller is reponsible for only calling this if nothing is using the server
	public closeServer(): boolean {
		if (this._server.isRunning) {
			this._server.closeServer();

			if (this.currentPanel) {
				this.currentPanel.close();
			}

			if (this._serverTaskProvider.isRunning) {
				this._serverTaskProvider.serverStop(true);
			}

			this._connectionManager.disconnected();
			return true;
		}
		return false;
	}

	private launchFileInExternalBrowser(file: string, relative: boolean) {
		const relFile = this.transformNonRelativeFile(relative, file).replace(
			/\\/g,
			'/'
		);
		const uri = vscode.Uri.parse(
			`http://${HOST}:${this._serverPort}${relFile}`
		);
		// will already resolve to local address
		vscode.env.openExternal(uri);
	}

	private launchFileInEmbeddedPreview(
		file: string,
		relative: boolean,
		panel: vscode.WebviewPanel | undefined
	) {
		file = this.transformNonRelativeFile(relative, file);
		// If we already have a panel, show it.
		if (this.currentPanel) {
			this.currentPanel.reveal(vscode.ViewColumn.Beside, file);
			return;
		}

		if (!panel) {
			// Otherwise, create a new panel.
			panel = vscode.window.createWebviewPanel(
				BrowserPreview.viewType,
				INIT_PANEL_TITLE,
				vscode.ViewColumn.Beside,
				{
					...this.getWebviewOptions(),
					...this.getWebviewPanelOptions(),
				}
			);
		}

		this.startEmbeddedPreview(panel, file);
	}

	private startEmbeddedPreview(panel: vscode.WebviewPanel, file: string) {
		if (this._currentTimeout) {
			clearTimeout(this._currentTimeout);
		}
		this.currentPanel = this._register(
			new BrowserPreview(
				file,
				panel,
				this._extensionUri,
				this._reporter,
				this._workspaceManager,
				this._connectionManager
			)
		);

		this._previewActive = true;

		this._register(
			this.currentPanel.onShiftToExternalBrowser(() => {
				if (
					!this._serverTaskProvider.isRunning &&
					this._runTaskWithExternalPreview
				) {
					this._serverTaskProvider.extRunTask(true);
				}
			})
		);

		this._register(
			this.currentPanel.onDispose(() => {
				this.currentPanel = undefined;
				const closeServerDelay = SettingUtil.GetConfig(
					this._extensionUri
				).serverKeepAliveAfterEmbeddedPreviewClose;
				this._currentTimeout = setTimeout(() => {
					// set a delay to server shutdown to avoid bad performance from re-opening/closing server.
					if (
						this._server.isRunning &&
						!this._serverTaskProvider.isRunning &&
						this.workspace &&
						this._runTaskWithExternalPreview
					) {
						this.closeServer();
					}
					this._previewActive = false;
				}, Math.floor(closeServerDelay * 1000 * 60));
			})
		);
	}

	public encodeEndpoint(location: string): string {
		return this._endpointManager.encodeLooseFileEndpoint(location);
	}

	public decodeEndpoint(location: string): string | undefined {
		return this._endpointManager.decodeLooseFileEndpoint(location);
	}

	public inServerWorkspace(file: string) {
		return this._workspaceManager.absPathInDefaultWorkspace(file);
	}

	public pathExistsRelativeToWorkspace(file: string) {
		return this._workspaceManager.pathExistsRelativeToDefaultWorkspace(file);
	}

	private transformNonRelativeFile(relative: boolean, file: string): string {
		if (!relative) {
			if (!this._workspaceManager.absPathInDefaultWorkspace(file)) {
				if (!this._workspaceManager.absPathInAnyWorkspace(file)) {
					this.notifyLooseFileOpen();
				}
				file = this.encodeEndpoint(file);
			} else {
				file = this._workspaceManager.getFileRelativeToDefaultWorkspace(file);
			}
		}
		return file;
	}

	private notifyLooseFileOpen() {
		/* __GDPR__
			"preview.fileOutOfWorkspace" : {}
		*/
		this._reporter.sendTelemetryEvent('preview.fileOutOfWorkspace');
		if (
			!this._notifiedAboutLooseFiles &&
			SettingUtil.GetConfig(this._extensionUri).notifyOnOpenLooseFile
		) {
			vscode.window
				.showWarningMessage(
					'Previewing a file that is not a child of the server root. To see fully correct relative file links, please open a workspace at the project root.',
					DONT_SHOW_AGAIN
				)
				.then((selection: vscode.MessageItem | undefined) => {
					if (selection == DONT_SHOW_AGAIN) {
						SettingUtil.UpdateSettings(Settings.notifyOnOpenLooseFile, false);
					}
				});
		}
		this._notifiedAboutLooseFiles = true;
	}

	public getWebviewOptions(
	): vscode.WebviewOptions {

		const options ={
			// Enable javascript in the webview
			enableScripts: true,
	
			localResourceRoots: [
				vscode.Uri.joinPath(this._extensionUri, 'media'),
				vscode.Uri.joinPath(
					this._extensionUri,
					'node_modules',
					'vscode-codicons',
					'dist'
				)
				
			],
		};

		// const workspaceURI = this._workspaceManager.workspaceURI;
		// if (workspaceURI) {
		// 	options.localResourceRoots.push(workspaceURI);
		// }
		return options;
	}
	
	public getWebviewPanelOptions(): vscode.WebviewPanelOptions {
		return {
			retainContextWhenHidden: true,
		};
	}
}


