module.exports = async (_, args, {pgdb}) => {
  return pgdb.public.feeds.findOne(args)
}
