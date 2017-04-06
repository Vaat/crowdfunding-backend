const { GraphQLScalarType } = require('graphql')
const { Kind } = require('graphql/language')
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY)
const querystring = require('querystring')
const uuid = require('uuid/v4')
const rndWord = require('random-noun-generator-german')
const kraut = require('kraut')
const geoipDatabase = require('geoip-database')
const maxmind = require('maxmind')
const cityLookup = maxmind.openSync(geoipDatabase.city)
const crypto = require('crypto')

const getGeoForIp = (ip) => {
  const geo = cityLookup.get(ip)
  let country = null
  try { country = geo.country.names.de } catch(e) { }
  let city = null
  try { city = geo.city.names.de } catch(e) { }
  if(!country && !city) {
    return null
  }
  if(city) {
    return city+', '+country
  }
  return country
}

const sendMail = (mail) => {
  const form = querystring.stringify(mail)
  const contentLength = form.length

  return fetch(`https://api.mailgun.net/v3/${process.env.MAILGUN_DOMAIN}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic '+(new Buffer('api:'+process.env.MAILGUN_API_KEY).toString('base64')),
      'Content-Length': contentLength,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form
  })
}

const signIn = (email, req) => {
  if(req.user) {
    //fail gracefully
    return {phrase: ''}
  }

  if(!email.match(/^.+@.+\..+$/)) {
    throw new Error('Email-Adresse nicht gültig.')
  }

  const token = uuid()
  const ua = req.headers['user-agent']
  const phrase = kraut.adjectives.random()+' '+kraut.verbs.random()+' '+rndWord()
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress
  const geo = getGeoForIp(ip)
  let geoString = ''
  if(geo) {
    geoString = 'Login Versuch aus: '+geo+'.\n\n'
  }

  req.session.email = email
  req.session.token = token
  req.session.ip = ip
  req.session.ua = ua
  if(geo) {
    req.session.geo = geo
  }

  const verificationUrl = (process.env.PUBLIC_URL || 'http://'+req.headers.host)+'/auth/email/signin/'+token
  sendMail({
    to: email,
    from: process.env.AUTH_MAIL_FROM_ADDRESS,
    subject: 'Login Link',
    text: `Ma’am, Sir,\n\n${geoString}Falls Ihnen dass Ihnen folgende Wörter angezeigt wurden: <${phrase}>,klicken Sie auf den folgenden Link um sich einzuloggen:\n${verificationUrl}\n`
  })

  return {phrase}
}

const resolveFunctions = {
  Date: new GraphQLScalarType({
    name: 'Date',
    description: 'Date custom scalar type',
    parseValue(value) {
      return new Date(value)
    },
    serialize(value) {
      return value.toISOString()
    },
    parseLiteral(ast) {
      if (ast.kind === Kind.STRING) {
        return new Date(ast.value)
      }
      return null
    },
  }),

  RootQuery: {
    async me(_, args, {loaders, pgdb, user}) {
      return user
    },
    async users(_, args, {loaders, pgdb}) {
      return pgdb.public.users.find( args )
    },
    async roles(_, args, {loaders, pgdb}) {
      return pgdb.public.roles.find( args )
    },
    async crowdfundings(_, args, {loaders, pgdb}) {
      return pgdb.public.crowdfundings.find()
    },
    async crowdfunding(_, args, {loaders, pgdb}) {
      return pgdb.public.crowdfundings.findOne( args )
    },
    async pledges(_, args, {loaders, pgdb, user}) {
      if(!user)
        return []
      return pgdb.public.pledges.find( {userId: user.id} )
    },
    async faqs(_, args, {pgdb}) {
      return pgdb.public.faqs.find( args )
    }
  },

  User: {
    async roles(user, args, {loaders, pgdb}) {
      const userRoles = await loaders.usersRolesForUserIds.load(user.id)
      const roleIds = usersRoles.map( (ur) => { return ur.roleId } )
      return loaders.roles.load(roleIds)
    },
    async address(user, args, {loaders, pgdb}) {
      if(!user.addressId)
        return null
      return pgdb.public.addresses.findOne({id: user.addressId})
    }
  },
  Role: {
    async users(role, args, {loaders, pgdb}) {
      const userRoles = await loaders.usersRolesForRoleIds.load(role.id)
      const userIds = usersRoles.map( (ur) => { return ur.userId } )
      return loaders.users.load(userIds)
    }
  },
  Crowdfunding: {
    async packages(crowdfunding, args, {loaders, pgdb}) {
      return pgdb.public.packages.find( {crowdfundingId: crowdfunding.id} )
    },
    async goal(crowdfunding) {
      return {
        money: crowdfunding.goalMoney,
        people: crowdfunding.goalPeople
      }
    },
    async status(crowdfunding, args, {loaders, pgdb}) {
      const money = await pgdb.public.queryOneField('SELECT SUM(total) FROM pledges pl JOIN packages pa ON pl."packageId"=pa.id WHERE pl.status = $1 AND pa."crowdfundingId" = $2', ['SUCCESSFULL', crowdfunding.id]) || 0
      const people = await pgdb.public.queryOneField('SELECT COUNT(DISTINCT("userId")) FROM pledges pl JOIN packages pa ON pl."packageId"=pa.id WHERE pl.status = $1 AND pa."crowdfundingId" = $2', ['SUCCESSFULL', crowdfunding.id])
      return {
        money,
        people
      }
    }
  },
  Package: {
    async options(package_, args, {loaders, pgdb}) {
      return pgdb.public.packageOptions.find( {packageId: package_.id} )
    }
  },
  PackageOption: {
    async reward(packageOption, args, {loaders, pgdb}) {
      return Promise.all( [
        pgdb.public.goodies.find( {rewardId: packageOption.rewardId} ),
        pgdb.public.membershipTypes.find( {rewardId: packageOption.rewardId} )
      ]).then( (arr) => {
        return arr[0].concat(arr[1])[0]
      })
    }
  },
  Reward: {
    __resolveType(obj, context, info) {
      // obj is the entity from the DB and thus has the "rewardType" column used as FK
      return obj.rewardType
    }
  },
  Pledge: {
    async options(pledge, args, {loaders, pgdb}) {
      const pledgeOptions = await pgdb.public.pledgeOptions.find( {pledgeId: pledge.id} )
      const pledgeOptionTemplateIds = pledgeOptions.map( (plo) => plo.templateId )
      const packageOptions = await pgdb.public.packageOptions.find( {id: pledgeOptionTemplateIds} )

      return packageOptions.map( (pko) => {
        const plo = pledgeOptions.find( (plo) => plo.templateId==pko.id )
        if(!plo) throw new Error("this should not happen")
        pko.id = plo.pledgeId+'-'+plo.templateId //combinded primary key
        pko.amount = plo.amount
        pko.templateId = plo.templateId
        pko.price = plo.price
        return pko
      })
    }
  },

  RootMutation: {
    async signIn(_, args, {loaders, pgdb, user, req}) {
      return signIn(args.email, req)
    },
    async signOut(_, args, {loaders, pgdb, user, req}) {
      if(!req.session)
        return
      req.session.destroy(function(err) {
        if(err) { throw (err) }
      })
      return true
    },
    async updateAddress(_, args, {loaders, pgdb, req, user}) {
      if(!user)
        throw new Error('unauthorized')
      const {address} = args
      if(!user.addressId) { //user has no address yet
        const transaction = await pgdb.transactionBegin()
        try {
          const userAddress = await transaction.public.addresses.insertAndGet(address)
          await transaction.public.users.update({id: user.id}, {
            addressId: userAddress.id
          })
          return transaction.transactionCommit()
        } catch(e) {
          await transaction.transactionRollback()
          throw e
        }
      } else { //update address of user
        return pgdb.public.addresses.update({id: user.addressId}, address)
      }
    },
    async submitQuestion(_, args, {loaders, pgdb, user}) {
      if(!user) {
        throw new Error('login required')
      }
      const { question } = args
      sendMail({
        to: process.env.QUESTIONS_MAIL_TO_ADDRESS,
        from: user.email,
        subject: 'new (FA)Question asked!',
        text: question
      })

      return {success: true}
    },
    async submitPledge(_, args, {loaders, pgdb, req}) {
      console.log(args)
      const transaction = await pgdb.transactionBegin()
      try {
        const { pledge } = args
        const pledgeOptions = pledge.options


        // load original of chosen packageOptions
        const pledgeOptionsTemplateIds = pledgeOptions.map( (plo) => plo.templateId )
        const packageOptions = await transaction.public.packageOptions.find({id: pledgeOptionsTemplateIds})

        // check if all templateIds are valid
        if(packageOptions.length<pledgeOptions.length)
          throw new Error("one or more of the claimed templateIds are/became invalid")

        // check if packageOptions are all from the same package
        // check if minAmount <= amount <= maxAmount
        let packageId = packageOptions[0].packageId
        pledgeOptions.forEach( (plo) => {
          const pko = packageOptions.find( (pko) => pko.id===plo.templateId)
          if(!pko) throw new Error("this should not happen")
          if(packageId!==pko.packageId)
            throw new Error("options must all be part of the same package!")
          if(!(pko.minAmount <= plo.amount <= pko.maxAmount))
            throw new Error(`amount in option (templateId: ${plo.templateId}) out of range`)
        })

        //check total
        const minTotal = Math.max(pledgeOptions.reduce(
          (amount, plo) => {
            const pko = packageOptions.find( (pko) => pko.id===plo.templateId)
            return amount + (pko.userPrice
              ? (pko.minUserPrice * plo.amount)
              : (pko.price * plo.amount))
          }
          , 0
        ), 100)

        if(pledge.total < minTotal)
          throw new Error(`pledge.total (${pledge.total}) should be >= (${total})`)

        //calculate donation
        const regularTotal = Math.max(pledgeOptions.reduce(
          (amount, plo) => {
            const pko = packageOptions.find( (pko) => pko.id===plo.templateId)
            return amount + (pko.price * plo.amount)
          }
          , 0
        ), 100)

        const donation = pledge.total - regularTotal
        // check reason
        if(donation < 0 && !pledge.reason)
          throw new Error('you must provide a reason for reduced pledges')


        let user = null
        if(req.user) { //user logged in
          if(pledge.user) {
            throw new Error('logged in users must no provide pledge.user')
          }
          user = req.user
        } else { //user not logged in
          if(!pledge.user) {
            throw new Error('pledge must provide a user if not logged in')
          }
          //try to load existing user by email
          user = await transaction.public.users.findOne({email: pledge.user.email})
          if(user) {
            if(user.verified) {
              throw new Error('a user with the email adress pledge.user.email already exists, login!')
            } else { //user not verified
              //update user with new details
              user = await transaction.public.users.updateAndGetOne({id: user.id}, {
                name: pledge.user.name
              })
            }
          } else {
            user = await transaction.public.users.insertAndGet({
              email: pledge.user.email,
              name: pledge.user.name,
              verified: false
            })
          }
        }

        //insert pledge
        let newPledge = {
          userId: user.id,
          packageId,
          total: pledge.total,
          donation: donation,
          reason: pledge.reason,
          status: 'DRAFT'
        }
        newPledge = await transaction.public.pledges.insertAndGet(newPledge)

        //insert pledgeOptions
        const newPledgeOptions = await Promise.all(pledge.options.map( (plo) => {
          plo.pledgeId = newPledge.id
          return transaction.public.pledgeOptions.insertAndGet(plo)
        }))
        newPledge.packageOptions = newPledgeOptions

        //commit transaction
        await transaction.transactionCommit()

        console.log(newPledge)
        return newPledge
      } catch(e) {
        await transaction.transactionRollback()
        throw e
      }
    },
    async payPledge(_, args, {loaders, pgdb, req}) {
      console.log(args)
      const transaction = await pgdb.transactionBegin()
      try {
        const { pledgePayment } = args

        //check pledgeId
        let pledge = await transaction.public.pledges.findOne({id: pledgePayment.pledgeId})
        if(!pledge) {
          throw new Error(`pledge (${pledgePayment.pledgeId}) not found`)
        }

        //load user
        let user = await transaction.public.users.findOne({id: pledge.userId})
        if(!user) {
          throw new Error('pledge user not found, this should not happen')
        }
        if(req.user) { //a user is logged in
          if(req.user.id !== user.id) {
            console.log("pledge doesn't belong to signed in user, transfering...")
            user = req.user
            pledge = await transaction.public.pledges.updateAndGetOne({id: pledge.id}, {userId: user.id})
          }
        }

        //check/charge payment
        let pledgeStatus
        let payment
        if(pledgePayment.method == 'PAYMENTSLIP') {
          pledgeStatus = 'WAITING_FOR_PAYMENT'
          payment = await transaction.public.payments.insertAndGet({
            type: 'PLEDGE',
            method: 'PAYMENTSLIP',
            total: pledge.total,
            status: 'WAITING'
          })

        } else if(pledgePayment.method == 'STRIPE') {
          if(!pledgePayment.sourceId) {
            throw new Error('sourceId required')
          }
          let charge = null
          try {
            charge = await stripe.charges.create({
              amount: pledge.total,
              currency: "chf",
              source: pledgePayment.sourceId
            })
          } catch(e) {
            //TODO log payment try?
            //throw to client
            throw e
          }
          pledgeStatus = 'SUCCESSFULL'
          //save payment (is done outside of transaction,
          //to never loose it again)
          payment = await pgdb.public.payments.insertAndGet({
            type: 'PLEDGE',
            method: 'STRIPE',
            total: charge.amount,
            status: 'PAID',
            pspId: charge.id,
            pspPayload: charge
          })
          //save sourceId to user
          await transaction.public.paymentSources.insert({
            method: 'STRIPE',
            userId: user.id,
            pspId: charge.source.id,
            pspPayload: charge.source
          })

        } else if(pledgePayment.method == 'POSTFINANCECARD') {
          const pspPayload = JSON.parse(pledgePayment.pspPayload)
          if(!pspPayload)
            throw new Error('pspPayload required')
          //check SHA of postfinance
          const SHASIGN = pspPayload.SHASIGN
          delete pspPayload.SHASIGN
          //sort params based on upper case order (urgh!)
          const pspPayloadKeys = Object.keys(pspPayload).sort(function(a, b){
            if(a.toUpperCase() < b.toUpperCase()) return -1;
            if(a.toUpperCase() > b.toUpperCase()) return 1;
            return 0;
          })
          let paramsString = ''
          const secret = process.env.PF_SHA_OUT_SECRET
          pspPayloadKeys.forEach( function(key) {
            let value = pspPayload[key]
            if(value)
              paramsString += `${key.toUpperCase()}=${value}${secret}`
          })
          const shasum = crypto.createHash('sha1')
          shasum.update(paramsString)
          if(SHASIGN!==shasum.digest('hex').toUpperCase())
            throw new Error('SHASIGN not correct!')

          //check for replay attacks
          if(await pgdb.public.payments.count({pspId: pspPayload.PAYID})) {
            throw new Error('this PAYID was used already 😲😒😢')
          }

          //save payment no matter what
          //PF amount is suddendly in franken
          payment = await pgdb.public.payments.insertAndGet({
            type: 'PLEDGE',
            method: 'POSTFINANCECARD',
            total: pspPayload.amount*100,
            status: 'PAID',
            pspId: pspPayload.PAYID,
            pspPayload: pspPayload
          })
          pledgeStatus = 'SUCCESSFULL'

          //check if amount is correct
          //PF amount is suddendly in franken
          //TODO really throw here?
          if(pspPayload.amount*100 !== pledge.total) {
            throw new Error('payed amount !== pledge.total')
          }

          //save alias to user
          if(pspPayload.ALIAS) {
            await transaction.public.paymentSources.insert({
              method: 'POSTFINANCECARD',
              userId: user.id,
              pspId: pspPayload.ALIAS
            })
          }

        } else if(pledgePayment.method == 'PAYPAL') {
          const pspPayload = JSON.parse(pledgePayment.pspPayload)
          if(!pspPayload || !pspPayload.tx)
            throw new Error('pspPayload(.tx) required')

          //check for replay attacks
          if(await pgdb.public.payments.count({pspId: pspPayload.tx})) {
            throw new Error('this transaction was used already 😲😒😢')
          }

          const transactionDetails = {
            'METHOD': 'GetTransactionDetails',
            'TRANSACTIONID': pspPayload.tx,
            'VERSION': '204.0',
            'USER': process.env.PAYPAL_USER,
            'PWD': process.env.PAYPAL_PWD,
            'SIGNATURE': process.env.PAYPAL_SIGNATURE
          }
          const form = querystring.stringify(transactionDetails)
          const contentLength = form.length
          const response = await fetch(process.env.PAYPAL_URL, {
            method: 'POST',
            headers: {
              'Content-Length': contentLength,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: form
          })
          const responseDict = querystring.parse(await response.text())
          if(responseDict.ACK !== 'Success')
            throw new Error('paypal transaction invalid')

          //get paypal amount (is decimal)
          const amount = parseFloat(responseDict.AMT)*100

          //save payment no matter what
          payment = await pgdb.public.payments.insertAndGet({
            type: 'PLEDGE',
            method: 'PAYPAL',
            total: amount,
            status: 'PAID',
            pspId: pspPayload.tx,
            pspPayload: responseDict
          })
          pledgeStatus = 'SUCCESSFULL'

          //check if amount is correct
          //TODO really throw here?
          if(amount !== pledge.total) {
            throw new Error('payed amount !== pledge.total')
          }
        } else {
          throw new Error('unsupported paymentMethod')
        }
        if(!payment || !pledgeStatus) {
          throw new Error('should not happen')
        }

        if(pledge.status !== pledgeStatus) {
          pledge = await transaction.public.pledges.updateAndGetOne({id: pledge.id}, {status: pledgeStatus})
        }

        //TODO generate Memberships

        //insert pledgePayment
        await transaction.public.pledgePayments.insert({
          pledgeId: pledge.id,
          paymentId: payment.id,
          paymentType: 'PLEDGE'
        })

        //commit transaction
        await transaction.transactionCommit()

        //signin user
        //if(!req.user) {
        //  signIn(user.email, req) //TODO return phrase
        //}

        console.log(pledge)
        return pledge
      } catch(e) {
        await transaction.transactionRollback()
        throw e
      }

    },
    async reclaimPledge(_, args, {loaders, pgdb, req}) {
      console.log(args)
      const transaction = await pgdb.transactionBegin()
      try {
        const { pledgeClaim } = args
        //check pledgeId
        let pledge = await transaction.public.pledges.findOne({id: pledgeClaim.pledgeId})
        if(!pledge) {
          throw new Error(`pledge (${pledgeClaim.pledgeId}) not found`)
        }
        //TODO do we need to check pledge.status here?

        //load original user of pledge
        const pledgeUser = await transaction.public.users.findOne({id: pledge.userId})
        if(!pledgeUser) {
          throw new Error('pledge user not found, this should not happen')
        }
        if(pledgeUser.email === pledgeClaim.email) {
          //TODO fail gracefully?
          throw new Error('pledge already belongs to the claiming email')
        }
        if(pledgeUser.verified) {
          throw new Error('cannot claim pledges of verified users')
        }

        //check logged in user
        if(req.user) {
          if(req.user.email !== pledgeClaim.email) {
            throw new Error('logged in users can only claim pledges to themselfs')
          }
          //transfer pledge to signin user
          pledge = await transaction.public.pledges.updateAndGetOne({id: pledge.id}, {userId: req.user.email})
        } else {
          //change email of pledgeUser
          await transaction.public.users.update({id: pledgeUser.id}, {email: pledgeClaim.email})
        }

        //commit transaction
        await transaction.transactionCommit()

        return pledge
      } catch(e) {
        await transaction.transactionRollback()
        throw e
      }
    }
  }
}

module.exports = resolveFunctions
