'use strict';

const fs = require('fs')
const contentful = require('contentful')
const algoliasearch = require('algoliasearch')
const listener = require("contentful-webhook-listener")
const webhook = listener.createServer()

// settings
const PORT = 5000
// Contentful Settings
const CONTENTFUL_SPACE_ID = 'contentful_space_id'
const CONTENTFUL_ACCESS_TOKEN = 'contentful_delivery_api_token'
// the file in which to store the next sync token, so if this app is restarted it'll pick up from where it left off
const SYNC_TOKEN_FILE = __dirname + 'syncToken'
// optional, comment out or set to '' if not using
// see https://www.contentful.com/developers/docs/references/content-delivery-api/#/reference/synchronization for details
const CONTENTFUL_SYNC_TYPE = 'Entry'
//optional, comment out or set to '' if not using
const CONTENTFUL_CONTENT_TYPE = 'post'
// time in seconds to wait after receiving publish webhook event before running subsequentSync
const CONTENTFUL_SYNC_DELAY = 60
// Algolia settings
const ALGOLIA_APP_ID = 'app_id'
const ALGOLIA_ADMIN_API_KEY = 'admin_api_key'
const ALGOLIA_INDEX_NAME = 'index_name'
// end of settings

// instantiate the contentful client with the appropriate space id and api token
const contentful_client = contentful.createClient({
  space: CONTENTFUL_SPACE_ID,
  accessToken: CONTENTFUL_ACCESS_TOKEN
})

// instantiate the algolia client with the appropriate app id, admin api token and setup the index
const algolia_client = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_API_KEY)
const algolia_index = algolia_client.initIndex(ALGOLIA_INDEX_NAME)

// store this somewhere to be used in the webhook listener
let nextSyncToken

// if sync_token_file exists, we read the next sync token from file
if (fs.existsSync(SYNC_TOKEN_FILE)) {
  nextSyncToken = fs.readFilesync(SYNC_TOKEN_FILE, 'utf8')
}

function initialSync() {
  // set options
  let options = { initial: true }
  if (CONTENTFUL_SYNC_TYPE) options.type = CONTENTFUL_SYNC_TYPE
  if (CONTENTFUL_CONTENT_TYPE) options.content_type = CONTENTFUL_CONTENT_TYPE

  // make the initial sync of the contentful space
  contentful_client.sync(options).then((response) => {
    let entries = response.entries
    nextSyncToken = response.nextSyncToken
    fs.writeFileSync(SYNC_TOKEN_FILE, nextSyncToken)

    // transform the contentful entries to include an objectID (which Algolia wants)
    // and to exclude the extraneous data (like the sys object)
    var _entries = entries.map(entry => {
      return Object.assign({}, { objectID: entry.sys.id }, entry.fields)
    })

    // add the transformed entries to the Algolia index
    algolia_index.addObjects(_entries, function(err, content) {
      if (err) console.error(err)
    })
  }).catch(console.error)
}

async function subsequentSync() {
  // set options
  let options = { nextSyncToken: nextSyncToken }
  if (CONTENTFUL_SYNC_TYPE) options.type = CONTENTFUL_SYNC_TYPE
  if (CONTENTFUL_CONTENT_TYPE) options.content_type = CONTENTFUL_CONTENT_TYPE

  // grab the updated content from Contentful using the nextSyncToken from the previous execution of the sync
  contentful_client.sync(options).then((response) => {
    // get and save the new nextSyncToken
    nextSyncToken = response.nextSyncToken
    fs.writeFileSync(SYNC_TOKEN_FILE, nextSyncToken)

    // remove entries/assets deleted from Contentful out of Algolia index
    let deleteObjectsOperation = deleteObjectsFromIndex(response, index)

    // combine all the new or updated entries/assets into one array
    let newItems = response.entries.concat(response.assets)
    // format the new items
    newItems = newItems.map(formatItem)
    // add new or updated entries/assets in Contentful to Algolia index
    let addObjectsOperation = addObjectsToIndex(response, index)

  }).catch(console.error)
}

function formatItem(item) {
  let itemSys = {
    objectID: item.sys.id,
    createdAt: item.sys.createdAt,
    updatedAt: item.sys.updatedAt,
    type: item.sys.type,
    contentType: item.sys.contentType.sys.id
  }
  let formattedItem = Object.assign({}, itemSys, item.fields)
  return formattedItem
}

function addObjectsToIndex(newItems, index) {
  if (newItems.length) {
    console.log('Adding ' + newItems.length + ' new objects to index')
    return index.addObjects(newItems).then(() =>
      console.log('Added new objects to the index'))
  } else {
    console.log('Nothing to add to the index')
    return Promise.resolve()
  }

  // same as before: transform the contentful entries to include an objectID (which Algolia
  // wants) and to exclude the extraneous data (like the sys object)
  var formattedNewEntries = new_or_updated_entries.map(formatEntry)

  // same as before: add the transformed updated/new entries to the Algolia index
  algolia_index.addObjects(formattedNewEntries).then(() => console.log('Added new objects to the index'))
}

function deleteObjectsFromIndex(response, index) {
  let deletedItems = response.deletedEntries.concat(response.deletedAssets)
  let deleteObjectsQueue = deletedItems.map((item) => item.sys.id)
  if (deleteObjectsQueue.length) {
    console.log('Deleting ' + deleteObjectsQueue.length + 'objects from the index')
    return index.deleteObjects(deleteObjectsQueue).then(() =>
      console.log('Deleted objects from index'))
  } else {
    console.log('Nothing to delete from the index')
    return Promise.resolve()
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms * 1000))
}

// This next bit runs a webhook processor listening for the contentful publish event.
// There is some delay built in because it takes a bit of time for the newly published
// entries to be copied over to the delivery infrastructure and made available to the Sync API.
// Test it out to see what works and perhaps something much quicker could work but a few minutes
// should definitely be adequate.
webhook.on("publish", async function(payload) {
  await sleep(CONTENTFUL_SYNC_DELAY)
  subsequentSync()
})

webhook.listen(PORT)

// if the next sync token hasn't been set, run the initial sync of content into algolia
if (!nextSyncToken)
  initialSync()
