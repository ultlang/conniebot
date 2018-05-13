'use strict'

/*
 * vars
 */

// libraries
const config = require('config')

/*
 * functions
 */

/**
 * Grabs body from RichEmbed, optionally discarding headers
 * @param {RichEmbed} message Message to grab body text from
 * @param {boolean} [headersImportant] Should keep headers?
 * @returns {String} Body of RichEmbed
 */
function handleBody (message, headersImportant) {
  let body = []
  if (message.fields) {
    message.fields.forEach(function (field) {
      let fieldString = headersImportant ? `**${field.name}**\n` : ''
      body.push(`${fieldString}${field.value}`)
    })
  }
  return body.join('\n\n')
}

/**
 * Choose appropriate message format depending on if settings is active
 * @param {RichEmbed} message Message to convert
 * @param {boolean} [headersImportant] Should keep headers?
 * @returns {(RichEmbed|String)} Message converted to appropriate format
 */
function output (message, headersImportant) {
  return config.get('embeds.active')
    ? message
    : strip(message, headersImportant)
}

/**
 * Convert RichEmbed to String
 * @param {RichEmbed} message Message to convert
 * @param {boolean} [headersImportant] Should keep headers?
 * @returns {String} String representation of RichEmbed
 */
function strip (message, headersImportant) {
  let title = message.title ? `**${message.title}**\n` : ''
  let desc = message.description ? `${message.description}\n` : ''
  let body = handleBody(message, headersImportant)

  return `${title}${desc}\n${body}`
}

/*
 * exports
 */

/**
  * Send message to channel
  * @param {Channel} channel Channel to send message to
  * @param {(RichEmbed|String)} message Message to send
  * @param {boolean} headersImportant Should keep headers if converted?
  * @returns {(Promise<(Message|Array<Message>)>)|null} Whatever message needs handling
  */
exports.send = function (channel, message, headersImportant = true) {
  return channel.send(output(message, headersImportant))
}
