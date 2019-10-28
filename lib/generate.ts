'use strict';

import assert from 'assert';
import chalk from 'chalk';
import fs from 'fs-extra';
import _ from 'lodash';
import ora from 'ora';
import path from 'path';

import getEngine from './template';
import {
  ArtifactConfig,
  CommandConfig,
  NodeNameFilterType,
  PossibleNodeConfigType,
  ProviderConfig,
  RemoteSnippet,
  SimpleNodeConfig,
} from './types';
import {
  getClashNodeNames,
  getClashNodes,
  getDownloadUrl,
  getNodeNames,
  getQuantumultNodes,
  getShadowsocksNodes,
  getShadowsocksNodesJSON,
  getShadowsocksrNodes,
  getSurgeNodes,
  loadRemoteSnippetList,
  normalizeClashProxyGroupConfig,
  toBase64,
  toUrlSafeBase64,
} from './utils';
import {
  hkFilter, japanFilter, koreaFilter,
  netflixFilter as defaultNetflixFilter, singaporeFilter, taiwanFilter,
  usFilter,
  youtubePremiumFilter as defaultYoutubePremiumFilter,
} from './utils/filter';
import getProvider from './utils/get-provider';
import { prependFlag } from './utils/flag';

const spinner = ora();

async function run(config: CommandConfig): Promise<void> {
  const artifactList: ReadonlyArray<ArtifactConfig> = config.artifacts;
  const distPath = config.output;
  const remoteSnippetsConfig = config.remoteSnippets || [];
  const remoteSnippetList = await loadRemoteSnippetList(remoteSnippetsConfig);

  await fs.remove(distPath);
  await fs.mkdir(distPath);

  for (const artifact of artifactList) {
    spinner.start(`正在生成规则 ${artifact.name}`);

    try {
      const result = await generate(config, artifact, remoteSnippetList);
      const destFilePath = path.join(config.output, artifact.name);
      await fs.writeFile(destFilePath, result);
      spinner.succeed(`规则 ${artifact.name} 生成成功`);
    } catch (err) {
      spinner.fail(`规则 ${artifact.name} 生成失败`);
      throw err;
    }
  }
}

export async function generate(
  config: CommandConfig,
  artifact: ArtifactConfig,
  remoteSnippetList: ReadonlyArray<RemoteSnippet>
): Promise<string> {
  const templateEngine = getEngine(config.templateDir);
  const {
    name: artifactName,
    template,
    customParams,
  } = artifact;

  assert(artifactName, '必须指定 artifact 的 name 属性');
  assert(template, '必须指定 artifact 的 template 属性');
  assert(artifact.provider, '必须指定 artifact 的 provider 属性');

  const gatewayConfig = config.gateway;
  const gatewayHasToken: boolean = !!(gatewayConfig && gatewayConfig.accessToken);
  const combineProviders = artifact.combineProviders || [];
  const providerList = [artifact.provider].concat(combineProviders);
  const nodeList: PossibleNodeConfigType[] = [];
  const nodeNameList: SimpleNodeConfig[] = [];
  let customFilters: ProviderConfig['customFilters'];
  let netflixFilter: NodeNameFilterType;
  let youtubePremiumFilter: NodeNameFilterType;

  if (config.binPath && config.binPath.v2ray) {
    config.binPath.vmess = config.binPath.v2ray;
  }

  for (const providerName of providerList) {
    const filePath = path.resolve(config.providerDir, `${providerName}.js`);

    if (!fs.existsSync(filePath)) {
      throw new Error(`文件 ${filePath} 不存在`);
    }

    spinner.text = `正在处理 Provider: ${providerName}`;
    let provider;
    let nodeConfigList;

    try {
      provider = getProvider(require(filePath));
    } catch (err) {
      err.message = `处理 Provider 时出现错误，相关文件 ${filePath} ，错误原因: ${err.message}`;
      throw err;
    }

    try {
      nodeConfigList = await provider.getNodeList();
    } catch (err) {
      err.message = `获取 Provider 节点时出现错误，相关文件 ${filePath} ，错误原因: ${err.message}`;
      throw err;
    }

    // Filter 仅使用第一个 Provider 中的定义
    if (!netflixFilter) {
      netflixFilter = provider.netflixFilter || defaultNetflixFilter;
    }
    if (!youtubePremiumFilter) {
      youtubePremiumFilter = provider.youtubePremiumFilter || defaultYoutubePremiumFilter;
    }
    if (!customFilters) {
      customFilters = provider.customFilters || {};
    }

    nodeConfigList.forEach(nodeConfig => {
      let isValid = false;

      if (!provider.nodeFilter) {
        isValid = true;
      } else if (provider.nodeFilter(nodeConfig)) {
        isValid = true;
      }

      if (config.binPath && config.binPath[nodeConfig.type]) {
        nodeConfig.binPath = config.binPath[nodeConfig.type];
        nodeConfig.localPort = provider.nextPort;
      }

      nodeConfig.surgeConfig = config.surgeConfig;

      if (provider.addFlag) {
        nodeConfig.nodeName = prependFlag(nodeConfig.nodeName);
      }

      if (isValid) {
        nodeNameList.push({
          type: nodeConfig.type,
          enable: nodeConfig.enable,
          nodeName: nodeConfig.nodeName,
        });
        nodeList.push(nodeConfig);
      }
    });
  }

  try {
    return templateEngine.render(`${template}.tpl`, {
      downloadUrl: getDownloadUrl(config.urlBase, artifactName, true, gatewayHasToken ? gatewayConfig.accessToken : undefined),
      nodes: nodeList,
      names: nodeNameList,
      remoteSnippets: _.keyBy(remoteSnippetList, item => {
        return item.name;
      }),
      nodeList,
      provider: artifact.provider,
      providerName: artifact.provider,
      artifactName,
      getDownloadUrl: (name: string) => getDownloadUrl(config.urlBase, name, true, gatewayHasToken ? gatewayConfig.accessToken : undefined),
      getNodeNames,
      getClashNodes,
      getClashNodeNames,
      getSurgeNodes,
      getShadowsocksNodes,
      getShadowsocksNodesJSON,
      getShadowsocksrNodes,
      getQuantumultNodes,
      usFilter,
      hkFilter,
      japanFilter,
      koreaFilter,
      singaporeFilter,
      taiwanFilter,
      toUrlSafeBase64,
      toBase64,
      encodeURIComponent,
      netflixFilter,
      youtubePremiumFilter,
      customFilters,
      customParams: customParams || {},
      ...(artifact.proxyGroupModifier ? {
        clashProxyConfig: {
          Proxy: getClashNodes(nodeList),
          'Proxy Group': normalizeClashProxyGroupConfig(
            nodeList,
            {
              usFilter,
              hkFilter,
              japanFilter,
              koreaFilter,
              singaporeFilter,
              taiwanFilter,
              netflixFilter,
              youtubePremiumFilter,
              ...customFilters,
            },
            artifact.proxyGroupModifier
          ),
        },
      } : {}),
    });
  } catch (err) {
    throw err;
  }

}

export default async function(config: CommandConfig): Promise<void> {
  console.log(chalk.cyan('开始生成规则'));
  await run(config)
    .catch(err => {
      if (spinner.isSpinning) {
        spinner.fail();
      }
      throw err;
    });
  console.log(chalk.cyan('规则生成成功'));
}
