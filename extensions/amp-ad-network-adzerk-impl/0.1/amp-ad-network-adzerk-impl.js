/**
 * Copyright 2018 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  AmpA4A,
  NO_CONTENT_RESPONSE,
  CreativeMetaDataDef,
} from '../../amp-a4a/0.1/amp-a4a';
import {AmpAdTemplates} from '../../amp-a4a/0.1/amp-ad-templates';
import {tryParseJson} from '../../../src/json';
import {dev} from '../../../src/log';
import {getMode} from '../../../src/mode';
import {utf8Decode, utf8Encode} from '../../../src/utils/bytes';
import {urls} from '../../../src/config';
import {startsWith} from '../../../src/string';
import {parseUrl} from '../../../src/url';

/** @type {string} */
const TAG = 'amp-ad-network-adzerk-impl';

/** @visibleForTesting @type {string} */
export const AMP_TEMPLATED_CREATIVE_HEADER_NAME = 'AMP-template-amp-creative';

/** @typedef {{
      ampCreativeTemplateUrl: string,
      templateMacroValues: (JsonObject|undefined),
    }} */
let AmpTemplateCreativeDef;

/** @private {?AmpAdTemplates} */
let ampAdTemplates;

/**
 * Fast Fetch implementation for AdZerk network that allows AMP creative
 * preferential render via AMP cache stored template expansion using
 * amp-mustache.  AMP creative response will consist of the following JSON
 * object with two fields:
 *
 * - ampCreativeTemplateId: number value for template ID.  Template must already
 *    have been stored in the AMP cache.
 * - templateMacroValues: optional JSON object mapping of macro name to its
 *    string value used to dynamically update the template
 *
 * Additionally, ad response must include header indicating AMP creative
 * template response: AMP-template-amp-creative: true
 *
 * Failure to properly fetch or expand template will result in slot collapsing.
 * Non-AMP creatives (defined as those not including AMP-template-amp-creative)
 * will be rendered via cross domain frame.
 */
export class AmpAdNetworkAdzerkImpl extends AmpA4A {

  /**
   * @param {!Element} element
   */
  constructor(element) {
    super(element);

    /** @private {?CreativeMetaDataDef} */
    this.creativeMetadata_ = null;

    /** @private {?AmpTemplateCreativeDef} */
    this.ampCreativeJson_ = null;

    ampAdTemplates = ampAdTemplates || new AmpAdTemplates(this.win);
  }

  /**
   * Validate the tag parameters.  If invalid, ad ad will not be displayed.
   * @override
   */
  isValidElement() {
    return !!this.getAdUrl();
  }

  /** @override */
  getSigningServiceNames() {
    // Does not utilize crypto signature based AMP creative validation.
    // TODO(keithwrightbos): move import of crypto validation into
    // implementations, reducing adzerk binary size.
    return [];
  }

  /** @override */
  getAdUrl() {
    const src = this.element.getAttribute('src');
    if (!/^https:\/\/adzerk.com\?id=\d+$/i.test(src)) {
      return '';
    }
    if (getMode(this.win).localDev) {
      return `http://ads.localhost:${this.win.location.port}` +
        '/adzerk/' + /^https:\/\/adzerk.com\?id=(\d+)/.exec(src)[1];
    }
    // TODO(adzerk): specify expected src path.
    return /^https:\/\/adzerk.com\?id=\d+$/i.test(src) ? src : '';
  }

  /** @override */
  maybeValidateAmpCreative(bytes, headers) {
    if (headers.get(AMP_TEMPLATED_CREATIVE_HEADER_NAME) !== 'true') {
      return /**@type {!Promise<(ArrayBuffer|null)>}*/ (Promise.resolve(null));
    }
    // Shorthand for: reject promise if current promise chain is out of date.
    const checkStillCurrent = this.verifyStillCurrent();
    return utf8Decode(bytes).then(body => {
      checkStillCurrent();
      this.ampCreativeJson_ = /** @type {!AmpTemplateCreativeDef} */
        (tryParseJson(body) || {});
      const proxyUrl = getMode(this.win).localDev
        ? this.ampCreativeJson_.ampCreativeTemplateUrl
        : this.getTemplateProxyUrl_(
            this.ampCreativeJson_.ampCreativeTemplateUrl);
      // TODO(keithwrightbos): macro value validation?  E.g. http invalid?
      return ampAdTemplates
          .fetch(proxyUrl)
          .then(parsedTemplate => {
            this.creativeMetadata_ = /** @type {!CreativeMetaDataDef} */
                (super.getAmpAdMetadata(parsedTemplate));
            return utf8Encode(this.creativeMetadata_.minifiedCreative);
          })
          .catch(error => {
            dev().warn(TAG, 'Error fetching/expanding template',
                this.ampCreativeJson_, error);
            this.forceCollapse();
            return Promise.reject(NO_CONTENT_RESPONSE);
          });
    });
  }

  /**
   * Converts the canonical template URL to the CDN proxy URL.
   * @param {string} url
   * @return {string}
   */
  getTemplateProxyUrl_(url) {
    const loc = parseUrl(url);
    const hostClean = startsWith(loc.host, 'www.')
      ? loc.host.slice(4)
      : loc.host;
    return loc.protocol + '//' + hostClean.replace('.', '-') + '.' +
        urls.cdn.slice(8) + '/a/s/' + hostClean + loc.pathname;
  }

  /** @override */
  getAmpAdMetadata(unusedCreative) {
    return /**@type {?CreativeMetaDataDef}*/(this.creativeMetadata_);
  }

  /** @override */
  onCreativeRender(unusedMetadata) {
    if (this.ampCreativeJson_ && this.ampCreativeJson_.templateMacroValues) {
      ampAdTemplates.render(
          this.ampCreativeJson_.templateMacroValues,
          this.iframe.contentWindow.document.body);
    }
  }
}


AMP.extension('amp-ad-network-adzerk-impl', '0.1', AMP => {
  AMP.registerElement('amp-ad-network-adzerk-impl', AmpAdNetworkAdzerkImpl);
});
