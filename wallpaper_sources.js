"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const https = require("https");
const Flickr = require("flickr-sdk");
const NodeCache = require("node-cache");

if (typeof (fetch) === "undefined") {
  fetch = require("fetch");
}

class WallpaperSource {
  constructor(module, config, id) {
    this.module = module;
    this.config = config;
    this.id = id;
    this.requestHandler = null;
    this.imageCache = {
      images: [],
      expires: Date.now(),
    };
  }

  request(params) {
    if (!("headers" in params)) {
      params.headers = {};
    }
    if (!("cache-control" in params.headers)) {
      params.headers["cache-control"] = "no-cache";
    }

    fetch(params.url, params).then(response => response.text().then(body => {
      const images = this.processResponse(body, response);

      if (Array.isArray(images) && images.length > 0) {
        this.cacheResult(images);
      }
    })).catch(err => {
      console.error(`Error requesting ${params.url}:`, err);
    });
  }

  cacheResult(images) {
    if (Array.isArray(images) && (images.length > 0)) {
      this.imageCache.expires = Date.now() + this.config.updateInterval * 0.9;
      this.imageCache.images = images;

      this.module.onSourceUpdated(this);
    }
  }

  fetch() {
    throw new Error("WallpaperSource.fetch must be implemented");
  }

  processResponse(body, response) {
    throw new Error("WallpaperSource.processResponse must be implemented");
  }

  refresh() {
    if ((this.config.maximumEntries <= this.imageCache.images.length) && (Date.now() < this.imageCache.expires)) {
      this.module.onSourceUpdated(this);
    } else {
      this.fetch();
    }
  }

  shuffle(items) {
    const source = items.slice(0);
    const result = [];
    let i, j;

    for (i = items.length; i > 0; --i) {
      j = Math.floor(Math.random() * i);
      result.push(source[j]);
      source[j] = source[i - 1];
    }

    return result;
  }
}

class ApodSource extends WallpaperSource {
  static matches(source) {
    return source === "apod" || source === "apodhd";
  }

  padDatePart(value) {
    return (value >= 0 && value < 10) ? `0${value}` : `${value}`;
  }

  fetch() {
    const startDate = new Date();

    startDate.setDate(startDate.getDate() - this.config.maximumEntries);
    const dateStr = `${this.padDatePart(startDate.getFullYear() % 100)}${this.padDatePart(startDate.getMonth() + 1)}${this.padDatePart(startDate.getDate())}`;

    this.request({ url: `https://science.nasa.gov/wp-json/wp/v2/apod-basic?date_from=${dateStr}` });
  }

  processResponse(body) {
    const images = [];

    for (const image of JSON.parse(body)) {
      if (image.media_type !== "image" || !("hdurl" in image)) {
        continue;
      }

      let url = image.hdurl;

      if (this.config.source === "apod") {
        const parsed = new URL(url);

        url = parsed.origin + parsed.pathname;
      }

      images.unshift({ url, caption: image.title });
    }
    return images;
  }
}

class BingSource extends WallpaperSource {
  constructor(module, config, id) {
    super(module, config, id);

    const width = config.orientation === "vertical" ? 1080 : 1920;
    const height = config.orientation === "vertical" ? 1920 : 1080;
    this.suffix = `_${width}x${height}.jpg`;
  }

  static matches(source) {
    return source === "bing";
  }

  fetch() {
    this.request({ url: `https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=${this.config.maximumEntries}` });
  }

  processResponse(body) {
    return JSON.parse(body).images.map(image => ({ url: `https://www.bing.com${image.urlbase}${this.suffix}`, caption: image.copyright }));
  }
}

class ChromecastSource extends WallpaperSource {
  static matches(source) {
    return source === "chromecast";
  }

  fetch() {
    this.request({ url: "https://clients3.google.com/cast/chromecast/home/v/c9541b08" });
  }

  processResponse(body) {
    const initState = eval(body.match(/JSON\.parse\('[^']+?\'\)/)[0]);

    return this.shuffle(initState[0].map(entry => ({ url: entry[0], caption: entry[1] })));
  }
}

class DirectUrlSource extends WallpaperSource {
  static matches(source) {
    return source.startsWith("http://") || source.startsWith("https://");
  }

  fetch() {
    let url = this.config.source;

    if (this.config.addCacheBuster) {
      url = `${url}${(url.indexOf("?") !== -1) ? "&" : "?"}mmm-wallpaper-ts=${Date.now()}`;
    }
    this.cacheResult([{ url, caption: this.config.source }]);
  }
}

class FireTvSource extends WallpaperSource {
  constructor(module, config, id) {
    super(module, config, id);

    this.images = JSON.parse(fs.readFileSync(`${__dirname}/firetv.json`)).images;
  }

  static matches(source) {
    return source === "firetv";
  }

  fetch() {
    this.cacheResult(this.shuffle(this.images));
  }
}

class FlickrSource extends WallpaperSource {
  static matches(source) {
    return source.startsWith("flickr-api:");
  }

  constructor(module, config, id) {
    super(module, config, id);

    this.sources = config.source.substring(11).split(";");
    this.flickr = new Flickr(config.flickrApiKey);
    this.flickr.favorites.getPhotos = this.flickr.favorites.getList;
    this.feeds = new Flickr.Feeds();
    this.dataCache = new NodeCache();
  }

  fetch() {
    Promise.all(this.sources.map(source => this.fetchOneSource(source))).then(results => {
      let photos = [...new Map(results.flat().map(p => [p.id, p])).values()];

      if (this.config.shuffle) {
        photos = this.shuffle(photos);
      }

      return this.processPhotos(photos);
    }).then(images => this.cacheResult(images));
  }

  fetchOneSource(source) {
    const args = source.split("/").filter(part => part.length > 0);

    if (args[0] === "publicPhotos") {
      return this.fetchFeed({ per_page: this.config.flickrResultsPerPage });
    }
    if (args[0] === "tags" && args.length > 1) {
      return this.fetchFeed({ tags: args[1], tagmode: args[2] || "all", per_page: this.config.flickrResultsPerPage });
    }
    if (args[0] === "photos" && args.length > 1) {
      if (args.length === 4 && args[2] === "galleries") {
        return this.fetchApiPhotos("galleries", "photos", { gallery_id: args[3], extras: "owner_name" });
      }

      return this.flickr.people.findByUsername({ username: args[1] }).then(res => {
        const user_id = res.body.user.id;

        if (args.length === 2) {
          return this.fetchApiPhotos("people", "photos", { user_id, extras: "owner_name" });
        }
        if (args.length === 3 && args[2] === "favorites") {
          return this.fetchApiPhotos("favorites", "photos", { user_id, extras: "owner_name" });
        }
        if (args.length === 4 && args[2] === "albums") {
          return this.fetchApiPhotos("photosets", "photoset", { user_id, photoset_id: args[3], extras: "owner_name" });
        }

        return [];
      });
    }
    if (args[0] === "groups" && args.length > 1) {
      return this.flickr.urls.lookupGroup({ url: `https://www.flickr.com/groups/${args[1]}/` }).then(res => this.fetchApiPhotos("groups.pools", "photos", { group_id: res.body.group.id, extras: "owner_name" }));
    }

    console.warn(`Unrecognised Flickr source ${source}, ignoring`);
    return Promise.resolve([]);
  }

  fetchFeed(args) {
    return this.feeds.publicPhotos(args).then(res => res.body.items.map(item => ({
      id: item.link.split("/").filter(part => part.length > 0).slice(-1)[0],
      title: item.title,
      owner: item.author.split('"').filter(part => part.length > 0).slice(-2)[0],
    })));
  }

  fetchApiPhotos(sourceType, resultType, args) {
    let source = this.flickr;

    for (const part of sourceType.split(".")) {
      source = source[part];
    }
    args.per_page = args.per_page || this.config.flickrResultsPerPage;
    return source.getPhotos(args).then(res => res.body[resultType].photo.map(photo => ({ id: photo.id, title: photo.title, owner: photo.ownername })));
  }

  processPhotos(photos) {
    photos = photos.slice(0, this.config.maximumEntries);
    return Promise.all(photos.map(photo => {
      const cached = this.dataCache.get(photo.id);

      if (cached !== undefined) {
        return Promise.resolve(cached);
      }

      return this.flickr.photos.getSizes({ photo_id: photo.id }).then(res => {
        const variants = res.body.sizes.size.filter(size => size.media === "photo").map(size => ({ url: size.source, width: +size.width, height: +size.height }));
        const selected = variants.reduce((prev, variant) => variant.width <= this.config.maxWidth && variant.height <= this.config.maxHeight ? variant : prev, undefined);

        if (selected === undefined) {
          return null;
        }

        const result = { url: selected.url, caption: `${photo.title} (by ${photo.owner})`, variants };

        this.dataCache.set(photo.id, result, this.config.flickrDataCacheTime);
        return result;
      }).catch(() => null);
    })).then(images => images.filter(image => image !== null));
  }
}

class ICloudSource extends WallpaperSource {
  static matches(source) {
    return source.startsWith("icloud:");
  }

  b62decode(value) {
    const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

    return value.split("").reduce((result, character) => result * 62 + alphabet.indexOf(character), 0);
  }

  fetch() {
    const album = this.config.source.substring(7).trim();
    const partition = this.b62decode((album[0] === "A") ? album[1] : album.substring(1, 3));

    this.host = `p${partition}-sharedstreams.icloud.com`;
    this.state = "webstream";
    this.photos = [];
    this.request({ method: "POST", url: `https://${this.host}/${album}/sharedstreams/webstream`, headers: { "Content-Type": "text/plain", "User-Agent": "MagicMirror:MMM-Wallpaper:v1.0 (by /u/kolbyhack)" }, body: '{"streamCtag":null}' });
  }

  processResponse(body, response) {
    const data = JSON.parse(body);
    const album = this.config.source.substring(7).trim();
    let images = [];

    if (this.state === "webstream") {
      if (response.status === 330) {
        this.host = data["X-Apple-MMe-Host"] || this.host;
        this.request({ method: "POST", url: `https://${this.host}/${album}/sharedstreams/webstream`, body: '{"streamCtag":null}' });
      } else if (response.status === 200) {
        if (this.config.shuffle) {
          data.photos = this.shuffle(data.photos);
        }

        this.photos = data.photos.filter(p => p != null).slice(0, this.config.maximumEntries);
        this.state = "webasseturls";
        this.request({ method: "POST", url: `https://${this.host}/${album}/sharedstreams/webasseturls`, body: JSON.stringify({ photoGuids: this.photos.map(p => p.photoGuid) }) });
      }
    } else if (this.state === "webasseturls") {
      for (const checksum in data.items) {
        const item = data.items[checksum];
        const loc = data.locations[item.url_location];
        const host = loc.hosts[Math.floor(Math.random() * loc.hosts.length)];

        for (const photo of this.photos) {
          for (const derivative of Object.values(photo.derivatives)) {
            if (derivative.checksum === checksum) {
              derivative.url = `${loc.scheme}://${host}${item.url_path}`;
            }
          }
        }
      }
      images = this.photos.map(photo => {
        const variants = Object.entries(photo.derivatives)
          .filter(([key, d]) => +d.width > 0 && key !== "PosterFrame")
          .map(([, d]) => ({ url: d.url, width: +d.width, height: +d.height }));

        variants.sort((a, b) => a.width * a.height - b.width * b.height);
        return { url: variants[variants.length - 1].url, caption: photo.caption, variants };
      });
    }

    return images;
  }
}

class JsonSource extends WallpaperSource {
  static matches(source) {
    return source.startsWith("json+http://") || source.startsWith("json+https://");
  }

  fetch() {
    let url = this.config.source.substring(5);

    if (this.config.addCacheBuster) {
      url = `${url}${(url.indexOf("?") !== -1) ? "&" : "?"}mmm-wallpaper-ts=${Date.now()}`;
    }
    this.request({ url });
  }

  processResponse(body) {
    return JSON.parse(body) || [];
  }
}

class LightroomSource extends WallpaperSource {
  constructor(module, config, id) {
    super(module, config, id);

    this.url = `https://${config.source.substring(10).trim()}`;
  }

  static matches(source) {
    return source.startsWith("lightroom:");
  }

  fetch() {
    this.request({ url: this.url });
  }

  processResponse(body) {
    let data = body.match(/data-srcset="[^"]+/g);

    if (this.config.shuffle) {
      data = this.shuffle(data);
    }

    const images = [];

    for (const srcset of data) {
      const variants = srcset.substring(13).split(",").map(v => {
        const parts = v.split(" ");

        return { url: parts[0], width: Number.parseInt(parts[1]), height: 1 };
      }).filter(v => v.width > 0);
      if (!variants.length) {
        continue;
      }

      variants.sort((a, b) => a.width - b.width);
      images.push({ url: variants[variants.length - 1].url, variants });
      if (images.length === this.config.maximumEntries) {
        break;
      }
    }

    return images;
  }
}

class LocalSource extends WallpaperSource {
  static matches(source) {
    return source.startsWith("local:");
  }

  constructor(module, config, id) {
    super(module, config, id);

    this.sourcePath = config.source.substring(6).trim();
    this.requestHandler = express.static(this.sourcePath);
  }

  fetch() {
    const fileMatcher = /\.(?:a?png|avif|gif|p?jpe?g|jfif|pjp|svg|webp|bmp)$/;

    const getFiles = async (dir, prefix) => {
      const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
      let images = [];

      for (const dirent of dirents) {
        const entpath = path.resolve(dir, dirent.name);

        if (dirent.isDirectory() && this.config.recurseLocalDirectories) {
          images = images.concat(await getFiles(entpath, `${prefix}${dirent.name}/`));
        } else if (dirent.isFile() && dirent.name.toLowerCase().match(fileMatcher) !== null) {
          images.push({ url: `${prefix}${dirent.name}`, caption: entpath });
        }
      }
      return images;
    };

    getFiles(this.sourcePath, "/").then(images => {
      this.cacheResult(this.config.shuffle ? this.shuffle(images) : images);
    });
  }
}

class MetMuseumSource extends WallpaperSource {
  constructor(module, config, id) {
    super(module, config, id);

    this.searchArgs = config.source.substring(10).split(",");
  }

  static matches(source) {
    return source.startsWith("metmuseum:");
  }

  fetch() {
    this.request({ url: `https://collectionapi.metmuseum.org/public/collection/v1/search?hasImages=true&departmentId=${this.searchArgs[0]}&isHighlight=${this.searchArgs[1]}&q=${this.searchArgs[2]}` });
  }

  processResponse(body) {
    const data = JSON.parse(body);

    if (data.objectIDs === null) {
      return [];
    }
    if (this.config.shuffle) {
      data.objectIDs = this.shuffle(data.objectIDs);
    }

    const objectIDs = data.objectIDs.slice(0, Math.min(60, this.config.maximumEntries));
    let pending = objectIDs.length;
    const images = [];

    if (!pending) {
      return [];
    }

    for (const id of objectIDs) {
      fetch(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`)
        .then(response => response.json())
        .then(object => {
          if (object.isPublicDomain) {
            images.push({ url: object.primaryImageSmall, caption: `${object.title} - ${object.artistDisplayName}` });
          }
        })
        .finally(() => {
          if (--pending === 0) {
            this.cacheResult(images);
          }
        });
    }
    return [];
  }
}

class NasaSource extends WallpaperSource {
  constructor(module, config, id) {
    super(module, config, id);

    this.searchTerm = config.source.split(":")[1];
  }

  static matches(source) {
    return source.startsWith("nasa:");
  }

  fetch() {
    if (!this.searchTerm) {
      console.error("MMM-Wallpaper: Please specify search term for NASA API");
      return;
    }

    this.request({ url: `https://images-api.nasa.gov/search?q=${this.searchTerm}` });
  }

  processResponse(body) {
    const items = JSON.parse(body).collection.items;

    if (!items) {
      return [];
    }

    return items.filter(item => item.data[0].media_type === "image" && item.links && item.links.length > 0).map(item => ({ url: item.links[0].href, caption: item.data[0].description_508 || item.data[0].title }));
  }
}

class PexelsSource extends WallpaperSource {
  static matches(source) {
    return source === "pexels";
  }

  fetch() {
    this.request({ url: `https://api.pexels.com/v1/search?query=${this.config.pexels_search}`, headers: { Authorization: this.config.pexels_key } });
  }

  processResponse(body) {
    const orientation = (this.config.orientation === "vertical") ? "portrait" : "landscape";

    return JSON.parse(body).photos.map(image => ({ url: image.src[orientation], caption: `Photographer: ${image.photographer}` }));
  }
}

class RedditSource extends WallpaperSource {
  static matches(source) {
    return source.startsWith("/r/") || source.startsWith("/user/");
  }

  fetch() {
    const path = this.config.source;

    // Reddit blocks the JSON API for most clients, so read the RSS feed with browser-like headers
    const url = path.toLowerCase().startsWith("/r/")
      ? `https://www.reddit.com${path}/hot.rss`
      : `https://www.reddit.com${path}.rss`;
    this.request({
      url,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1"
      }
    });
  }

  processResponse(body, response) {
    console.log(`Reddit returned HTTP Status: ${response.status}`);

    const images = [];

    // Decode the HTML entities so we can read the feed
    const decodedBody = (typeof body === "string" ? body : "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    // Split the XML into individual posts, skipping the feed header
    const entries = decodedBody.split("<entry>").slice(1);
    // Only direct image hosts; preview.redd.it links are deliberately excluded
    const imgRegex = /(https:\/\/(?:i\.redd\.it|i\.imgur\.com)\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp))/i;

    for (const entry of entries) {
      const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/i);
      const postTitle = titleMatch ? titleMatch[1].trim() : "Reddit Wallpaper";
      const imgMatch = entry.match(imgRegex);

      if (imgMatch) {
        const cleanUrl = imgMatch[1];

        if (!images.find(img => img.url === cleanUrl)) {
          const thumbMatch = entry.match(/<media:thumbnail url="([^"]+)"/i);

          images.push({
            url: cleanUrl,
            caption: postTitle,
            previewUrl: thumbMatch ? thumbMatch[1] : null
          });

          if (images.length === this.config.maximumEntries) {
            break;
          }
        }
      }
    }

    console.log(`Extracted ${images.length} images from Reddit XML.`);

    if (images.length > 0) {
      // The feed has no image sizes, so read them from each file's header before publishing
      Promise.all(images.map(image => this.addVariants(image))).then(results => this.cacheResult(results));
    }
    return [];
  }

  async addVariants({ url, caption, previewUrl }) {
    if (!this.sizeCache) {
      this.sizeCache = new Map();
    }
    if (!this.sizeCache.has(url)) {
      if (this.sizeCache.size >= 500) {
        this.sizeCache.clear();
      }
      this.sizeCache.set(url, await probeImageSize(url));
    }

    const size = this.sizeCache.get(url);
    if (!size) {
      // Unknown size: no variants, so the frontend just uses the full image
      return { url, caption };
    }

    const variants = [{ url, width: size.width, height: size.height }];
    const previewWidth = previewUrl ? Number.parseInt(new URL(previewUrl).searchParams.get("width"), 10) : NaN;

    if (previewWidth > 0 && previewWidth < size.width) {
      variants.unshift({ url: previewUrl, width: previewWidth, height: Math.round(previewWidth * size.height / size.width) });
    }
    return { url, caption, variants };
  }
}

// Reads width/height from the start of a JPEG, PNG, GIF or WebP file. Returns null if unknown.
function readImageSize(buf) {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && buf.toString("ascii", 0, 4) === "GIF8") {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);

    if (chunk === "VP8 ") {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === "VP8L") {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") {
      return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    }
    return null;
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;

    while (offset + 9 <= buf.length) {
      if (buf[offset] !== 0xff) {
        return null;
      }
      const marker = buf[offset + 1];

      if (marker === 0xff) {
        offset += 1; // fill byte
      } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) };
      } else if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        offset += 2; // markers without a length
      } else {
        offset += 2 + buf.readUInt16BE(offset + 2);
      }
    }
  }
  return null;
}

// Downloads only the first part of an image to read its dimensions.
async function probeImageSize(url, maxBytes = 65536) {
  try {
    const response = await fetch(url, { headers: { Range: `bytes=0-${maxBytes - 1}` } });

    if (!response.ok || !response.body) {
      return null;
    }

    // Stop reading at maxBytes even if the server ignores the Range header
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;

    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      total += value.length;
    }
    reader.cancel().catch(() => {});

    const size = readImageSize(Buffer.concat(chunks));
    return (size && size.width > 0 && size.height > 0) ? size : null;
  } catch (err) {
    console.warn(`Could not read image size for ${url}: ${err.message}`);
    return null;
  }
}

class UnsplashSource extends WallpaperSource {
  static matches(source) {
    return source.startsWith("unsplash");
  }

  get apiKey() {
    return this.config.unsplashApiKey || this.config.unsplashAccessKey;
  }

  fetch() {
    const config = this.config;

    if (!this.apiKey) {
      console.error("Please specify an API key for Unsplash (unsplashApiKey)");
      return;
    }

    let query = "";
    if (config.source.includes(":")) {
      query = config.source.substring(config.source.indexOf(":") + 1).trim();
    } else if (config.unsplashQuery) {
      query = config.unsplashQuery.trim();
    } else if (config.unsplashSearch) {
      query = config.unsplashSearch.trim();
    }

    const params = new URLSearchParams();
    // When exclusions are configured, request the API maximum so enough photos survive filtering
    const hasExclusions = (config.unsplashExcludeKeywords || []).length > 0 || (config.unsplashExcludeIds || []).length > 0;
    const count = hasExclusions ? 30 : Math.min(Math.max(config.maximumEntries, 1), 30);
    params.append("count", count);

    if (config.orientation === "vertical") {
      params.append("orientation", "portrait");
    } else if (config.orientation === "horizontal") {
      params.append("orientation", "landscape");
    }

    if (query.length > 0) {
      params.append("query", query);
    } else if (config.unsplashCollections) {
      params.append("collections", config.unsplashCollections);
    }

    if (config.unsplashTopics) {
      params.append("topics", config.unsplashTopics);
    }
    if (config.unsplashUsername) {
      params.append("username", config.unsplashUsername);
    }
    if (config.unsplashFeatured) {
      params.append("featured", "true");
    }

    this.request({
      url: `https://api.unsplash.com/photos/random?${params.toString()}`,
      headers: {
        Authorization: `Client-ID ${this.apiKey}`,
        "Accept-Version": "v1",
      },
    });
  }

  processResponse(body, response) {
    if (response.status !== 200) {
      console.error(`Unsplash API error (HTTP ${response.status}): ${body}`);
      return [];
    }

    let data;
    try {
      data = JSON.parse(body);
    } catch (e) {
      console.error("Failed to parse Unsplash response JSON:", e);
      return [];
    }

    if (data.errors) {
      console.error("Unsplash API returned errors:", data.errors);
      return [];
    }

    const photos = Array.isArray(data) ? data : [data];
    const excludeIds = new Set(this.config.unsplashExcludeIds || []);
    const excludeKeywords = (this.config.unsplashExcludeKeywords || []).map(k => k.toLowerCase());
    const images = [];

    for (const photo of photos) {
      if (!photo || !photo.urls || excludeIds.has(photo.id)) {
        continue;
      }
      if (excludeKeywords.length > 0) {
        // Match whole words in the slug and descriptions, so "man" doesn't match "mansion"
        const text = [photo.slug, photo.description, photo.alt_description].filter(Boolean).join(" ").toLowerCase();
        const words = new Set(text.split(/[^a-z0-9]+/));
        if (excludeKeywords.some(k => words.has(k))) {
          continue;
        }
      }

      const photographer = (photo.user && photo.user.name) ? photo.user.name : "Unsplash";
      const description = photo.description || photo.alt_description;
      const caption = description
        ? `${description} (Photo by ${photographer} on Unsplash)`
        : `Photo by ${photographer} on Unsplash`;

      const photoWidth = photo.width || 1920;
      const photoHeight = photo.height || 1080;
      const aspectRatio = photoWidth / photoHeight;
      const variants = [];

      if (photo.urls.regular) {
        variants.push({
          url: photo.urls.regular,
          width: (photoWidth >= photoHeight) ? 1080 : Math.round(1080 * aspectRatio),
          height: (photoWidth >= photoHeight) ? Math.round(1080 / aspectRatio) : 1080,
        });
      }
      if (photo.urls.full) {
        variants.push({ url: photo.urls.full, width: photoWidth, height: photoHeight });
      }
      if (photo.urls.raw) {
        variants.push({ url: photo.urls.raw, width: photoWidth, height: photoHeight });
      }

      variants.sort((a, b) => a.width * a.height - b.width * b.height);

      images.push({
        url: photo.urls.full || photo.urls.regular || photo.urls.raw,
        caption,
        variants,
      });

      if (images.length === this.config.maximumEntries) {
        break;
      }
    }

    return images;
  }
}

class SynologyMomentsSource extends WallpaperSource {
  static matches(source) {
    return source.startsWith("synology-moments:");
  }

  constructor(module, config, id) {
    super(module, config, id);

    this.sharedAlbumUrlText = config.source.substring(17).trim();
    const sharedAlbumUrl = new URL(this.sharedAlbumUrlText);
    const lastSlash = sharedAlbumUrl.pathname.lastIndexOf("/");
    this.apiPath = `${sharedAlbumUrl.pathname.substring(0, lastSlash)}/webapi/entry.cgi`;
    this.apiUrl = `${sharedAlbumUrl.protocol}//${sharedAlbumUrl.host}${this.apiPath}`;
    this.album = sharedAlbumUrl.pathname.substring(lastSlash + 1);
    this.imageMap = {};
    this.sessionCookie = null;
    this.requestHandler = this.makeImageHandler(sharedAlbumUrl);
  }

  makeImageHandler(url) {
    return (oreq, ores) => {
      const options = {
        host: url.host,
        port: url.port,
        protocol: url.protocol,
        path: this.imageMap[oreq.url],
        method: "GET",
        headers: {
          "cache-control": "none",
          cookie: this.sessionCookie
        }
      };
      const protocol = url.protocol === "http:" ? http : https;
      const preq = protocol.request(options, pres => {
        ores.writeHead(pres.statusCode, pres.headers);
        pres.on("data", chunk => ores.write(chunk));
        pres.on("close", () => ores.end());
        pres.on("end", () => ores.end());
      }).on("error", error => {
        try {
          ores.writeHead(500);
          ores.write(error.message);
        } catch (_) {
        }
        ores.end();
      });
      preq.end();
    };
  }

  fetch() {
    this.state = "create_session";
    this.request({ url: this.sharedAlbumUrlText });
  }

  processResponse(body, response) {
    if (response.status !== 200) {
      console.error(`ERROR: ${response.status} -- ${body}`);
      return [];
    }

    if (this.state === "create_session") {
      if ("set-cookie" in response.headers) {
        this.sessionCookie = response.headers["set-cookie"][0].split(";")[0];
        this.state = "browse_item";
        this.request({
          method: "POST",
          url: this.apiUrl,
          body: `additional=["thumbnail","resolution","orientation","video_convert","video_meta"]&offset=0&limit=${this.config.maximumEntries}&passphrase="${this.album}"&api="SYNO.Photo.Browse.Item"&method="list"&version=3`,
          headers: {
            cookie: this.sessionCookie,
            "x-syno-sharing": this.album
          }
        });
      }
      return [];
    }
    const data = JSON.parse(body);

    return data.data.list.map(item => {
      this.imageMap[`/${item.id}`] = `${this.apiPath}?id=${item.id}&cache_key=${item.additional.thumbnail.cache_key}&type="unit"&size="xl"&api="SYNO.Photo.Thumbnail"&method="get"&version=1&_sharing_id="${this.album}"&passphrase="${this.album}"`;
      return { url: item.id };
    });
  }
}

const SOURCE_TYPES = [
  ApodSource,
  BingSource,
  ChromecastSource,
  DirectUrlSource,
  FireTvSource,
  FlickrSource,
  ICloudSource,
  JsonSource,
  LightroomSource,
  LocalSource,
  MetMuseumSource,
  NasaSource,
  PexelsSource,
  RedditSource,
  SynologyMomentsSource,
  UnsplashSource
];

function createSource(module, config, id) {
  const source = config.source.toLowerCase();
  const SourceClass = SOURCE_TYPES.find(sourceType => sourceType.matches(source)) || BingSource;

  return new SourceClass(module, config, id);
}

module.exports = { WallpaperSource, createSource };
